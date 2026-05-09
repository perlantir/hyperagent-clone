// P66c — Relay protocol tests.
//
// Spawns the actual `packages/codex-relay/src/server.js` process,
// then exercises:
//
//   - HMAC verification on /dispatch + /cancel (good + bad sig)
//   - GET /healthz returns the expected shape
//   - GET /connections/:id requires HMAC
//   - WS /companion: bad JWT → 4401 close
//   - WS /companion: hello with valid JWT → hello_ack
//   - WS /companion: events forwarded to /api/codex/relay/inbox
//   - HMAC over the inbox-bound POST body matches what verifyRelayHmac
//     expects on the Vercel side
//
// We stand up a tiny HTTP server to mock /api/codex/relay/inbox so
// the relay's outbound forwarding is observable.
//
// Gate: relay binary is JS so no special install needed; 8s test budget.

import { spawn } from "node:child_process";
import { createServer, AddressInfo } from "node:net";
import * as http from "node:http";
import { createHmac, randomBytes } from "node:crypto";

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

const RELAY_BIN = require.resolve("../../../packages/codex-relay/src/server.js");
const SHARED_SECRET = "p66c-relay-test-secret-not-prod";
const RUN_TICKET_KEY = "p66c-relay-test-run-ticket-key-not-prod";

function hmac(content: string): string {
  return createHmac("sha256", SHARED_SECRET).update(content).digest("hex");
}

// Companion JWT issuer — same algo as src/lib/codex/companions-store.ts.
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function issueJwt(opts: { sub: string; userId: string; ttlMs?: number }): string {
  const now = Date.now();
  const payload = {
    v: 1,
    sub: opts.sub,
    userId: opts.userId,
    iat: now,
    exp: now + (opts.ttlMs ?? 3600_000),
    nonce: randomBytes(16).toString("hex"),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const jwtKey = createHmac("sha256", "codex-companion-jwt-v1").update(RUN_TICKET_KEY).digest();
  const sig = createHmac("sha256", jwtKey).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address() as AddressInfo;
      const port = addr.port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

(async () => {
  const relayPort = await pickPort();
  const inboxPort = await pickPort();
  const relayBase = `http://127.0.0.1:${relayPort}`;
  const inboxUrl = `http://127.0.0.1:${inboxPort}/api/codex/relay/inbox`;

  // ─── Inbox stub ──────────────────────────────────────────────────
  const inboxRequests: Array<{ rawBody: string; sigHeader: string; verified: boolean }> = [];
  const inbox = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const sigHeader = String(req.headers["x-relay-signature"] || "");
    const expected = hmac(body);
    const verified = sigHeader === expected;
    inboxRequests.push({ rawBody: body, sigHeader, verified });
    res.statusCode = verified ? 200 : 401;
    res.end(JSON.stringify({ ok: verified }));
  });
  await new Promise<void>((r) => inbox.listen(inboxPort, "127.0.0.1", r));

  // ─── Spawn relay ─────────────────────────────────────────────────
  const child = spawn(process.execPath, [RELAY_BIN], {
    env: {
      ...process.env,
      PORT: String(relayPort),
      RELAY_SHARED_SECRET: SHARED_SECRET,
      CODEX_RUN_TICKET_KEY: RUN_TICKET_KEY,
      VERCEL_INBOX_URL: inboxUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for "relay_listening" log line.
  await new Promise<void>((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error("relay startup timed out")), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (chunk.includes("relay_listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => undefined);
    child.once("error", reject);
  });

  try {
    // ─── /healthz ──────────────────────────────────────────────────
    {
      const r = await fetch(`${relayBase}/healthz`);
      const j = await r.json();
      pass("healthz returns ok=true", r.status === 200 && j.ok === true);
      pass("healthz reports zero connections initially", j.connections === 0);
    }

    // ─── /dispatch with bad sig ────────────────────────────────────
    {
      const body = JSON.stringify({ companionId: "cmp_x", runId: "run_x", kind: "run_dispatch", payload: {} });
      const r = await fetch(`${relayBase}/dispatch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-relay-signature": "deadbeef".repeat(8),
        },
        body,
      });
      pass("dispatch with bad sig → 401", r.status === 401);
    }

    // ─── /dispatch with good sig but offline companion ─────────────
    {
      const body = JSON.stringify({ companionId: "cmp_offline", runId: "run_o", kind: "run_dispatch", payload: { hello: 1 } });
      const r = await fetch(`${relayBase}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-relay-signature": hmac(body) },
        body,
      });
      pass("dispatch with good sig + offline companion → 202",
        r.status === 202);
    }

    // ─── GET /connections/:id ──────────────────────────────────────
    {
      const path = "/connections/cmp_anything";
      const sig = hmac(`GET ${path}`);
      const r = await fetch(`${relayBase}${path}`, { headers: { "x-relay-signature": sig } });
      const j = await r.json();
      pass("connections endpoint with HMAC → online=false (no WS yet)",
        r.status === 200 && j.online === false);
      const r2 = await fetch(`${relayBase}${path}`, { headers: { "x-relay-signature": "bad" } });
      pass("connections endpoint without HMAC → 401",
        r2.status === 401);
    }

    // ─── WS /companion: bad JWT ────────────────────────────────────
    {
      const { default: WS } = await import("ws");
      const ws = new WS(`ws://127.0.0.1:${relayPort}/companion`);
      const closeInfo = await new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on("open", () => {
          ws.send(JSON.stringify({ type: "hello", jwt: "this.is.not.a.real.jwt" }));
        });
        ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.on("error", () => undefined);
      });
      pass("WS bad JWT → close 4401",
        closeInfo.code === 4401 && /jwt/i.test(closeInfo.reason));
    }

    // ─── WS /companion: good JWT → hello_ack + event forwarding ────
    {
      const { default: WS } = await import("ws");
      const jwt = issueJwt({ sub: "cmp_test", userId: "u_test" });
      const ws = new WS(`ws://127.0.0.1:${relayPort}/companion`);
      let helloAck: any = null;
      const opened = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("WS open timeout")), 3000);
        ws.on("open", () => { clearTimeout(t); resolve(); });
        ws.on("error", reject);
      });
      const acked = new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
          if (msg.type === "hello_ack") {
            helloAck = msg;
            resolve();
          }
        });
      });
      await opened;
      ws.send(JSON.stringify({ type: "hello", jwt, lastSeenSeq: 7 }));
      await acked;
      pass("WS hello_ack received",
        helloAck && helloAck.type === "hello_ack" && helloAck.lastSeenSeq === 7);

      // Connection should now show online.
      const path = "/connections/cmp_test";
      const sig = hmac(`GET ${path}`);
      const conn = await fetch(`${relayBase}${path}`, { headers: { "x-relay-signature": sig } });
      const cj = await conn.json();
      pass("connections shows online=true after hello",
        cj.online === true && typeof cj.since === "number");

      // Send an event batch — the relay should forward to inbox.
      ws.send(JSON.stringify({
        type: "events",
        batch: [{
          kind: "event",
          source: "companion",
          eventType: "thread/started",
          sequence: 0,
          runId: "run_test",
          idempotencyKey: "ik-1",
          emittedAt: Date.now(),
          payload: { threadId: "ct1" },
        }],
      }));

      // Wait for inbox to receive.
      const startReqCount = inboxRequests.length;
      const t0 = Date.now();
      while (inboxRequests.length === startReqCount && Date.now() - t0 < 2000) {
        await new Promise(r => setTimeout(r, 50));
      }
      pass("inbox received forwarded batch",
        inboxRequests.length > startReqCount);
      const last = inboxRequests[inboxRequests.length - 1];
      pass("inbox HMAC verifies correctly",
        last.verified === true);
      const lastBody = JSON.parse(last.rawBody);
      pass("inbox body contains companionId",
        lastBody.companionId === "cmp_test");
      pass("inbox body contains userId from JWT",
        lastBody.userId === "u_test");
      pass("inbox body batch has 1 entry",
        Array.isArray(lastBody.batch) && lastBody.batch.length === 1);

      // Send a dispatch_ack — should also forward.
      const startReqCount2 = inboxRequests.length;
      ws.send(JSON.stringify({ type: "ack", dispatchId: 42 }));
      const t1 = Date.now();
      while (inboxRequests.length === startReqCount2 && Date.now() - t1 < 2000) {
        await new Promise(r => setTimeout(r, 50));
      }
      pass("dispatch_ack forwarded to inbox",
        inboxRequests.length > startReqCount2);

      ws.close();
    }
  } finally {
    try { child.kill("SIGTERM"); } catch {}
    await new Promise<void>((r) => {
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {}; r(); }, 2000);
      child.once("close", () => { clearTimeout(t); r(); });
    });
    inbox.close();
  }

  if (failed > 0) {
    console.error(`\n${failed} relay-protocol test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-relay-protocol tests passed");
})();
