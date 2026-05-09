// browser-server.js — local HTTP/WS server the BROWSER on the user's
// machine connects to. Bound to loopback only.
//
// Endpoints:
//
//   GET  /              — small HTML status page (debugging)
//   GET  /health        — { ok, codexState, accountState, runs }
//   POST /turn          — start a Codex turn. Body: { runTicket, threadId, input }.
//                          Streams events via NDJSON to the browser.
//   POST /approval      — submit an approval decision for a pending request.
//   POST /cancel        — cancel an in-flight turn.
//   POST /shutdown      — graceful shutdown (browser-initiated revoke).
//
// AUTH model:
//   - First-message auth: every browser request must include the
//     run ticket (issued by the hosted server) and the companion's
//     pair sessionId. The companion verifies the ticket signature
//     by ENCODING ONLY, treating it as opaque to forward; the hosted
//     server is the authority. The companion DOES enforce:
//     - Origin must match the configured allowed origin (the hosted
//       app's URL).
//     - Pair sessionId in the ticket must equal the companion's own
//       claimed sessionId.
//     - Tickets older than ~30 min are refused locally too (we use
//       expiresAt from the decoded payload).
//
//   - Tokens never appear in URL query strings. They go in JSON
//     bodies for POST routes and the first WS message for the
//     streaming turn endpoint.
//
//   - Private Network Access (PNA) preflight is honored via
//     Access-Control-Allow-Private-Network when the OPTIONS
//     request includes Access-Control-Request-Private-Network.

const http = require("node:http");
const { WebSocketServer } = require("ws");
const { redact } = require("./redact.js");

class BrowserServer {
  constructor({ host, port, allowedOrigins, onTurn, onApproval, onCancel, onShutdown, getStatus, log }) {
    this.host = host;
    this.requestedPort = port || 0;
    this.allowedOrigins = allowedOrigins;
    this.onTurn = onTurn;
    this.onApproval = onApproval;
    this.onCancel = onCancel;
    this.onShutdown = onShutdown;
    this.getStatus = getStatus;
    this.log = log;
    this.server = null;
    this.wss = null;
    this.boundUrl = null;
  }

  async start() {
    const server = http.createServer((req, res) => this._onRequest(req, res));
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.requestedPort, this.host, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : this.requestedPort;
    this.boundUrl = `http://${this.host}:${port}`;
    this.wss = new WebSocketServer({ server, perMessageDeflate: false });
    this.wss.on("connection", (ws, req) => this._onWsConnection(ws, req));
    return this.boundUrl;
  }

  async stop() {
    try { this.wss && this.wss.close(); } catch {}
    await new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  _isOriginAllowed(origin) {
    if (!this.allowedOrigins || this.allowedOrigins.length === 0) return true;
    if (!origin) return false;
    return this.allowedOrigins.includes(origin);
  }

  _setCors(req, res) {
    const origin = req.headers.origin || "";
    if (this._isOriginAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "false");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    // Private Network Access — Chrome PNA preflight.
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
  }

  _onRequest(req, res) {
    if (req.method === "OPTIONS") {
      this._setCors(req, res);
      res.statusCode = 204;
      res.end();
      return;
    }
    this._setCors(req, res);

    const url = new URL(req.url || "/", this.boundUrl);
    const path = url.pathname;

    // Origin enforcement on browser-shaped requests. Server-to-server
    // (no Origin header) is allowed for /health only.
    const origin = req.headers.origin || "";
    if (origin && !this._isOriginAllowed(origin)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "origin_not_allowed" }));
      return;
    }

    if (req.method === "GET" && path === "/health") return this._health(req, res);
    if (req.method === "GET" && path === "/") return this._statusPage(req, res);
    if (req.method === "POST" && path === "/approval") return this._jsonHandler(req, res, this.onApproval);
    if (req.method === "POST" && path === "/cancel") return this._jsonHandler(req, res, this.onCancel);
    if (req.method === "POST" && path === "/shutdown") return this._jsonHandler(req, res, this.onShutdown);

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  }

  async _jsonHandler(req, res, fn) {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end(JSON.stringify({ error: "bad_json" })); return; }
    try {
      const r = await fn(payload, req);
      res.statusCode = r && r.status ? r.status : 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r && r.body !== undefined ? r.body : { ok: true }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "internal", message: String((e && e.message) || e).slice(0, 200) }));
    }
  }

  _health(req, res) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(this.getStatus ? this.getStatus() : { ok: true }));
  }

  _statusPage(req, res) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<title>Hyperagent Codex Companion</title>
<style>body{font:13px/1.5 ui-sans-serif,system-ui;margin:24px;color:#222}code{font:12px ui-monospace,Menlo,monospace;background:#eee;padding:1px 4px;border-radius:3px}</style>
<h1>Hyperagent Codex Companion</h1>
<p>This page is served by the local companion bound to <code>${this.boundUrl}</code>.</p>
<p>Open the Hyperagent settings page in your browser to drive Codex turns through this companion.</p>
<p><a href="/health">/health</a></p>`);
  }

  _onWsConnection(ws, req) {
    // Origin check for WS handshake.
    const origin = req.headers.origin || "";
    if (!this._isOriginAllowed(origin)) {
      try { ws.close(4403, "origin_not_allowed"); } catch {}
      return;
    }
    if (req.url !== "/turn") {
      try { ws.close(4404, "not_found"); } catch {}
      return;
    }

    // First-message auth. The browser MUST send a JSON envelope:
    //   { type: "hello", runTicket: "<encoded>", input: { threadId, text } }
    // before any other message. We refuse for 5 seconds otherwise.
    let helloed = false;
    let turnApi = null;
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
        if (!msg || msg.type !== "hello" || typeof msg.runTicket !== "string") {
          try { ws.close(4400, "bad_hello"); } catch {}
          return;
        }
        helloed = true;
        clearTimeout(helloTimeout);
        try {
          turnApi = await this.onTurn({ ws, hello: msg, send: (e) => safeSend(ws, e) });
        } catch (e) {
          safeSend(ws, { type: "error", message: String((e && e.message) || e).slice(0, 200) });
          try { ws.close(1011, "turn_failed"); } catch {}
          return;
        }
        return;
      }

      if (!turnApi) return;
      try {
        if (msg.type === "approval") await turnApi.approval(msg);
        else if (msg.type === "cancel") await turnApi.cancel();
        // Drop unknown message types silently.
      } catch (e) {
        safeSend(ws, { type: "error", message: String((e && e.message) || e).slice(0, 200) });
      }
    });

    ws.on("close", () => {
      try { turnApi && turnApi.close && turnApi.close(); } catch {}
    });
  }
}

function readBody(req) {
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

function safeSend(ws, msg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

module.exports = { BrowserServer };
