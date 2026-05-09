#!/usr/bin/env node
//
// hyperagent-codex-relay — long-lived relay between Hyperagent's
// hosted Vercel app and the user's local companion. (P66c)
//
// Runs as a small standalone Node service on Fly.io / Railway / etc.
// Vercel posts dispatch packets via HTTPS; the relay holds the WS to
// the right companion and forwards. Companion-emitted events come
// back over WS and the relay POSTs them to Vercel's
// /api/codex/relay/inbox.
//
// AUTH MODEL
//
//   Vercel ↔ relay   : HMAC of a shared secret (RELAY_SHARED_SECRET).
//                       Vercel signs each /dispatch + /cancel; relay
//                       signs each callback.
//   Companion → relay: companion JWT issued by Vercel
//                       (CODEX_RUN_TICKET_KEY-derived). Relay verifies
//                       on every WS frame; expired JWT → 4401.
//
// STATE
//
//   In-memory `Map<companionId, ws>` for active connections. Persistent
//   state (dispatch queue + companion registry) lives in Vercel's
//   Postgres; the relay is intentionally stateless beyond the WS map.
//
// ENV
//
//   RELAY_SHARED_SECRET   shared with Vercel; HMAC over /dispatch + /cancel
//   CODEX_RUN_TICKET_KEY  shared with Vercel; verifies companion JWTs
//   PORT                  listen port (default 8400)
//   VERCEL_INBOX_URL      where to forward companion events
//                         e.g. https://app.example.com/api/codex/relay/inbox
//
// ENDPOINTS
//
//   WS    /companion              authenticated by JWT in first message
//   POST  /dispatch               { signature, runId, companionId, kind, payload }
//   POST  /cancel                 { signature, runId, companionId }
//   GET   /healthz                { ok, connections }
//   GET   /connections/:companionId   { online, since } (HMAC-authed)
//
// SECURITY
//
//   - The relay does NOT see ChatGPT/Codex tokens. Events are already
//     redacted upstream.
//   - The relay does NOT log payload bytes — only metadata
//     (runId, companionId, kind, byteSize, latencyMs).
//   - The relay does NOT persist events; if Vercel /inbox is down,
//     the event is queued in-memory + retried; if the relay crashes
//     mid-flight, those events are lost (companion will replay on
//     reconnect via lastSeenAcknowledgedSeq).

const http = require("node:http");
const { createHmac, timingSafeEqual } = require("node:crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8400);
const SHARED_SECRET = process.env.RELAY_SHARED_SECRET || "";
const RUN_TICKET_KEY = process.env.CODEX_RUN_TICKET_KEY
  || process.env.APP_SECRET || process.env.NEXTAUTH_SECRET || process.env.SESSION_SECRET || "";
const VERCEL_INBOX_URL = process.env.VERCEL_INBOX_URL || "";

if (!SHARED_SECRET) {
  console.error("RELAY_SHARED_SECRET must be set; refusing to start");
  process.exit(1);
}
if (!RUN_TICKET_KEY) {
  console.error("CODEX_RUN_TICKET_KEY (or APP_SECRET) must be set; refusing to start");
  process.exit(1);
}

// Same key derivation used by `src/lib/codex/companions-store.ts` so
// JWTs issued by Vercel verify here.
const JWT_KEY = createHmac("sha256", "codex-companion-jwt-v1").update(RUN_TICKET_KEY).digest();

// ─── State ───────────────────────────────────────────────────────────

const connections = new Map(); // companionId → { ws, since }

function relayLog(level, msg, fields = {}) {
  const ts = new Date().toISOString();
  // Structured JSON log; never include payload bytes.
  process.stdout.write(JSON.stringify({ ts, level, msg, ...fields }) + "\n");
}

// ─── HMAC verification (Vercel → relay) ───────────────────────────────

function hmacVerify(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", SHARED_SECRET).update(rawBody).digest("hex");
  let provided;
  try { provided = Buffer.from(signatureHeader, "hex"); }
  catch { return false; }
  const expectedBuf = Buffer.from(expected, "hex");
  if (provided.length !== expectedBuf.length) return false;
  try { return timingSafeEqual(provided, expectedBuf); }
  catch { return false; }
}

// ─── JWT verification (companion → relay) ─────────────────────────────

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function verifyJwt(token) {
  if (typeof token !== "string") return null;
  const ix = token.indexOf(".");
  if (ix < 0) return null;
  const payloadB64 = token.slice(0, ix);
  const sigB64 = token.slice(ix + 1);
  const expected = createHmac("sha256", JWT_KEY).update(payloadB64).digest();
  let provided;
  try { provided = b64urlDecode(sigB64); }
  catch { return null; }
  if (provided.length !== expected.length) return null;
  let okSig = false;
  try { okSig = timingSafeEqual(provided, expected); }
  catch { okSig = false; }
  if (!okSig) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")); }
  catch { return null; }
  if (payload.v !== 1) return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}

// ─── HTTP server ─────────────────────────────────────────────────────

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    const MAX = 1024 * 1024; // 1 MB
    req.on("data", (c) => {
      len += c.length;
      if (len > MAX) {
        req.destroy(new Error("body_too_large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost`);
  const path = url.pathname;

  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json");

  try {
    if (req.method === "GET" && path === "/healthz") {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, connections: connections.size, ts: Date.now() }));
      return;
    }

    if (req.method === "GET" && path.startsWith("/connections/")) {
      // Vercel polls this to know which companion is online. HMAC-authed.
      const companionId = path.slice("/connections/".length);
      const sigHeader = req.headers["x-relay-signature"] || "";
      if (!hmacVerify(`GET ${path}`, Array.isArray(sigHeader) ? sigHeader[0] : sigHeader)) {
        res.statusCode = 401; res.end(JSON.stringify({ error: "bad_signature" })); return;
      }
      const conn = connections.get(companionId);
      res.statusCode = 200;
      res.end(JSON.stringify({
        online: !!conn,
        since: conn ? conn.since : null,
      }));
      return;
    }

    if (req.method === "POST" && (path === "/dispatch" || path === "/cancel")) {
      const body = await readBody(req);
      const sigHeader = req.headers["x-relay-signature"] || "";
      if (!hmacVerify(body, Array.isArray(sigHeader) ? sigHeader[0] : sigHeader)) {
        res.statusCode = 401; res.end(JSON.stringify({ error: "bad_signature" })); return;
      }
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { res.statusCode = 400; res.end(JSON.stringify({ error: "bad_json" })); return; }
      const { companionId, runId, kind, payload } = parsed;
      if (typeof companionId !== "string" || typeof runId !== "string") {
        res.statusCode = 400; res.end(JSON.stringify({ error: "bad_params" })); return;
      }
      const conn = connections.get(companionId);
      if (!conn) {
        // Companion offline — Vercel queued this in codex_run_dispatch_queue
        // already; return 202 so Vercel knows the relay tried.
        res.statusCode = 202;
        res.end(JSON.stringify({ ok: false, reason: "companion_offline" }));
        return;
      }
      const frame = {
        type: path === "/cancel" ? "cancel" : "dispatch",
        runId,
        kind: kind || "run_dispatch",
        payload: payload ?? null,
      };
      try {
        conn.ws.send(JSON.stringify(frame));
        relayLog("info", "dispatch_forwarded", {
          companionId: companionId.slice(0, 12) + "…",
          runId: runId.slice(0, 12) + "…",
          kind: frame.type,
          bytes: JSON.stringify(frame).length,
        });
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, delivered: true }));
      } catch (e) {
        res.statusCode = 502;
        res.end(JSON.stringify({ ok: false, reason: "ws_send_failed" }));
      }
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (e) {
    relayLog("error", "request_error", { error: String(e && e.message || e).slice(0, 200) });
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "internal" }));
  }
});

// ─── WebSocket server ────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: "/companion" });

wss.on("connection", (ws, req) => {
  let companionId = null;
  let userId = null;
  let helloed = false;
  const helloTimeout = setTimeout(() => {
    if (!helloed) {
      try { ws.close(4401, "no_hello"); } catch {}
    }
  }, 5000);

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(typeof data === "string" ? data : data.toString("utf8")); }
    catch { try { ws.close(4400, "bad_json"); } catch {} return; }

    if (!helloed) {
      if (msg.type !== "hello" || typeof msg.jwt !== "string") {
        try { ws.close(4400, "bad_hello"); } catch {}
        return;
      }
      const payload = verifyJwt(msg.jwt);
      if (!payload) {
        try { ws.close(4401, "bad_jwt"); } catch {}
        return;
      }
      helloed = true;
      clearTimeout(helloTimeout);
      companionId = payload.sub;
      userId = payload.userId;

      // Drop any prior connection for this companion (last-writer-wins;
      // a re-pair / restart should always claim).
      const existing = connections.get(companionId);
      if (existing && existing.ws !== ws) {
        try { existing.ws.close(4000, "superseded"); } catch {}
      }
      connections.set(companionId, { ws, since: Date.now(), userId });
      relayLog("info", "companion_connected", { companionId: companionId.slice(0, 12) + "…" });

      // Acknowledge the hello so the client knows it's ready.
      ws.send(JSON.stringify({ type: "hello_ack", lastSeenSeq: msg.lastSeenSeq ?? 0 }));
      return;
    }

    // Subsequent messages: events from the companion to forward to
    // Vercel's /api/codex/relay/inbox.
    if (msg.type === "events" && Array.isArray(msg.batch)) {
      forwardEventsToVercel({ companionId, userId, batch: msg.batch }).catch((e) => {
        relayLog("warn", "inbox_forward_failed", { error: String(e && e.message || e).slice(0, 200) });
      });
      return;
    }
    if (msg.type === "ack" && typeof msg.dispatchId === "number") {
      // Companion confirms it consumed a dispatch. We forward to
      // Vercel via the inbox so dispatchQueue.deliveredAt advances.
      forwardEventsToVercel({
        companionId, userId,
        batch: [{ kind: "dispatch_ack", dispatchId: msg.dispatchId }],
      }).catch(() => undefined);
      return;
    }
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
  });

  ws.on("close", () => {
    if (companionId) {
      const cur = connections.get(companionId);
      if (cur && cur.ws === ws) connections.delete(companionId);
      relayLog("info", "companion_disconnected", {
        companionId: (companionId || "").slice(0, 12) + "…",
      });
    }
    clearTimeout(helloTimeout);
  });

  ws.on("error", () => undefined);
});

// ─── Outbound to Vercel /inbox ───────────────────────────────────────

async function forwardEventsToVercel({ companionId, userId, batch }) {
  if (!VERCEL_INBOX_URL) return;
  const body = JSON.stringify({ companionId, userId, batch, ts: Date.now() });
  const sig = createHmac("sha256", SHARED_SECRET).update(body).digest("hex");
  const res = await fetch(VERCEL_INBOX_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-relay-signature": sig,
    },
    body,
  });
  if (!res.ok) {
    relayLog("warn", "inbox_non_2xx", { status: res.status });
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────

server.listen(PORT, () => {
  relayLog("info", "relay_listening", { port: PORT });
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    relayLog("info", "shutting_down", { signal: sig });
    // Tell every companion to reconnect.
    for (const [, conn] of connections) {
      try { conn.ws.close(4000, "relay_restart"); } catch {}
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}

// Exports for unit tests.
module.exports = { hmacVerify, verifyJwt, connections };
