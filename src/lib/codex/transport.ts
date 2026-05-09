// P57 — Codex app-server transport interface.
//
// Two transports:
//   1. WebSocket (the production-viable path on Vercel) — connects to a
//      bridge running on the user's machine via codex app-server's
//      --listen flag, authenticated with a capability token.
//   2. Stdio (self-hosted only) — spawns `codex app-server` as a child
//      process. Stubbed today; would require a long-running runtime
//      to be useful.
//
// Both transports speak newline-framed JSON-RPC 2.0. We frame on
// "\n" boundaries so the same JsonRpcClient consumes either.

import { redactRpcEnvelope } from "./redact";

export interface Transport {
  // Send a fully-formed JSON-RPC envelope. The transport adds framing.
  send(envelope: any): Promise<void>;
  // Subscribe to incoming envelopes. The transport invokes onMessage
  // whenever a complete JSON-RPC frame arrives. onClose fires once when
  // the underlying connection ends (clean or error).
  onMessage(handler: (envelope: any) => void): void;
  onClose(handler: (err?: Error) => void): void;
  // Close the underlying connection. Idempotent.
  close(): Promise<void>;
}

// ─── WebSocket transport ─────────────────────────────────────────────
//
// P64.2 — Real-binary smoke testing against codex 0.130.0 revealed
// the following:
//
//   - The codex app-server expects the capability token via the
//     Authorization: Bearer <TOKEN> request header. Subprotocol-based
//     auth (Sec-WebSocket-Protocol: codex-bridge.bearer.<TOKEN>) and
//     query-string auth (?token=, ?access_token=) are both rejected
//     with HTTP 401 at the WS handshake.
//
//   - The framing accepted by codex over WS is BOTH newline-delimited
//     AND message-per-frame. We continue to send newline-terminated
//     frames so the same envelope-builder works for stdio + WS.
//
//   - When the listener is started without `--ws-auth`, loopback
//     bindings accept unauthenticated clients. This is INSECURE on a
//     shared machine — any other process (or any other browser tab via
//     localhost-cors-bypass) can drive the bridge. We therefore always
//     require a capability token in the bridge config and always send
//     it via Authorization header for server-side dispatch.
//
//   - Browsers cannot set arbitrary headers on WebSocket connections.
//     This means the BROWSER cannot directly authenticate to a
//     `--ws-auth capability-token` codex bridge. Browser-direct
//     dispatch can therefore ONLY connect to an unauthenticated
//     loopback codex (insecure) — the documented path for hosted
//     deployments is the companion proxy (P65) that translates a
//     browser-friendly auth scheme into the Authorization header
//     codex requires.
//
// Server-side connections in this file go through the `ws` npm
// package (which supports custom request headers). When called from a
// browser bundle, we fall back to the platform WebSocket but refuse to
// attach the capability token — the caller has already been informed
// that a companion is required.

export interface WebSocketTransportOptions {
  url: string;
  capabilityToken: string;
  // Allow callers to pass a custom WebSocket impl for tests.
  webSocketImpl?: any;
  // P64.2 — Pre-resolved IP address (and family). When supplied, the
  // server-side path will pin the underlying TCP connection to this
  // exact address via a custom `lookup` function — eliminating the
  // DNS-rebinding TOCTOU window between url-safety's verifyResolvedIp
  // call and the WebSocket library's own DNS lookup at connect time.
  preResolvedAddress?: string;
  preResolvedFamily?: 4 | 6;
}

export async function createWebSocketTransport(opts: WebSocketTransportOptions): Promise<Transport> {
  // Validate URL safety up front — never silently downgrade to ws://.
  const url = new URL(opts.url);
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) {
    throw new Error(
      `Refusing to connect to non-TLS Codex bridge at ${redactString(opts.url)}. Use wss:// for remote hosts; ws:// is only allowed on loopback.`,
    );
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported transport protocol: ${url.protocol}`);
  }

  const isBrowser = typeof window !== "undefined" && typeof (globalThis as any).document !== "undefined";

  // Pick implementation. Server-side (Node) path uses the `ws` package
  // because the platform `WebSocket` in older Node versions cannot set
  // headers, and even when it can the API surface differs. The browser
  // path uses the platform implementation.
  let wsAny: any;
  let serverSidePath = false;
  if (opts.webSocketImpl) {
    wsAny = await constructWithImpl(opts.webSocketImpl, url, opts);
    // Treat custom impls as server-side capable so tests can exercise
    // the auth-header path without pulling `ws` into a browser bundle.
    serverSidePath = true;
  } else if (!isBrowser) {
    serverSidePath = true;
    let WsImpl: any;
    try {
      // Dynamic import keeps `ws` out of the browser bundle. Suppress
      // module ordering quirks under tsx by going through eval-like
      // dynamic resolution.
      const mod = await import("ws");
      WsImpl = (mod as any).default || (mod as any).WebSocket || mod;
    } catch (e: any) {
      throw new Error(
        `Server-side WebSocket support requires the \`ws\` package. Install it with \`npm i ws\`. Underlying error: ${e?.message || "unknown"}`,
      );
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.capabilityToken}`,
    };
    const wsOpts: any = { headers };
    if (opts.preResolvedAddress) {
      // Pin the TCP connect to the IP we already validated. The `ws`
      // package forwards `lookup` to net.connect / tls.connect.
      const family: 4 | 6 = opts.preResolvedFamily || 4;
      wsOpts.lookup = (
        _hostname: string,
        _options: any,
        callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
      ) => callback(null, opts.preResolvedAddress!, family);
    }
    wsAny = new WsImpl(opts.url, wsOpts);
  } else {
    // Browser path — platform WebSocket, no headers possible.
    if (typeof WebSocket === "undefined") {
      throw new Error("No WebSocket implementation available in this runtime");
    }
    // We deliberately DO NOT attach the capability token here. The
    // codex app-server requires it via Authorization header which is
    // unreachable from the browser. Use the companion proxy (P65) for
    // browser-driven dispatch against a `--ws-auth`-protected codex.
    wsAny = new WebSocket(opts.url);
  }

  const messageHandlers: ((env: any) => void)[] = [];
  const closeHandlers: ((err?: Error) => void)[] = [];
  let buffer = "";
  let closed = false;

  await waitForOpen(wsAny);

  attachMessageHandler(wsAny, (data: string) => {
    buffer += data;
    // Frame on newlines. Codex accepts both newline-delimited and
    // message-per-frame; we tolerate either by walking the buffer.
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const env = JSON.parse(line);
        for (const h of messageHandlers) h(env);
      } catch {
        // Drop malformed frames silently — we never log raw bytes.
      }
    }
    // Also tolerate a complete JSON envelope arriving without a newline.
    if (buffer.length > 0) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const env = JSON.parse(trimmed);
          buffer = "";
          for (const h of messageHandlers) h(env);
        } catch {
          // Partial frame; wait for more data.
        }
      }
    }
  });

  attachCloseHandler(wsAny, () => {
    if (closed) return;
    closed = true;
    for (const h of closeHandlers) h();
  });
  attachErrorHandler(wsAny, () => {
    if (closed) return;
    closed = true;
    // We DON'T forward the underlying event — it may carry callback URLs.
    for (const h of closeHandlers) h(new Error("Codex bridge socket error"));
  });

  return {
    async send(envelope: any) {
      const frame = JSON.stringify(envelope) + "\n";
      wsAny.send(frame);
    },
    onMessage(h) { messageHandlers.push(h); },
    onClose(h) { closeHandlers.push(h); },
    async close() {
      if (closed) return;
      closed = true;
      try { wsAny.close(1000, "client_close"); } catch {}
    },
  };
}

// ─── tiny adapter layer ──────────────────────────────────────────────
// Both the `ws` package and the browser platform WebSocket expose
// "open"/"message"/"close"/"error" but with different listener shapes.
// We hide that here.

async function constructWithImpl(Impl: any, url: URL, opts: WebSocketTransportOptions): Promise<any> {
  // Custom impls in tests may follow either the platform shape (no
  // headers param) or the `ws` shape (headers param). We try the
  // headers-aware variant first and fall back.
  try {
    return new Impl(opts.url, undefined, {
      headers: { Authorization: `Bearer ${opts.capabilityToken}` },
    });
  } catch {
    return new Impl(opts.url);
  }
}

async function waitForOpen(ws: any): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Codex bridge connection timed out")), 8000);
    if (typeof ws.on === "function") {
      // ws-package style.
      ws.once("open", () => { clearTimeout(t); resolve(); });
      ws.once("unexpected-response", (_req: any, res: any) => {
        clearTimeout(t);
        reject(new Error(`Codex bridge handshake failed: HTTP ${res?.statusCode || "?"}`));
      });
      ws.once("error", (e: any) => {
        clearTimeout(t);
        reject(new Error(`Codex bridge connection error: ${e?.message || "unknown"}`));
      });
    } else {
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = (e: any) => { clearTimeout(t); reject(new Error(`Codex bridge connection error: ${e?.message || "unknown"}`)); };
    }
  });
}

function attachMessageHandler(ws: any, handler: (data: string) => void) {
  if (typeof ws.on === "function") {
    ws.on("message", (data: Buffer | string) => {
      handler(typeof data === "string" ? data : data.toString("utf8"));
    });
  } else {
    ws.onmessage = (ev: any) => {
      const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
      handler(data);
    };
  }
}

function attachCloseHandler(ws: any, handler: () => void) {
  if (typeof ws.on === "function") ws.on("close", handler);
  else ws.onclose = handler;
}
function attachErrorHandler(ws: any, handler: () => void) {
  if (typeof ws.on === "function") ws.on("error", handler);
  else ws.onerror = handler;
}

// ─── Stdio transport (Phase 2 — local runtime only) ──────────────────
//
// Spawns `codex app-server` as a long-lived child process and frames
// JSON-RPC messages over its stdio. ONLY callable when the Node host
// can keep a process alive across requests — Vercel and other
// serverless platforms must use the WebSocket bridge instead.
//
// Lifecycle:
//   - First call spawns `codex app-server`
//   - stdout is line-framed; each line is JSON-parsed and dispatched
//   - stderr is forwarded as `log` notifications (filtered to warn/error)
//   - exit / disconnect → onClose handlers fire so callers can rebuild
//     the AppServerClient for the next turn
//
// We deliberately do NOT pool a single transport across multiple turns
// in this iteration — each turn opens a fresh stdio process. Pooling
// requires careful concurrency management (multiple in-flight requests
// against one app-server) and is a follow-up.

export interface StdioTransportOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Working directory for the child. Defaults to process.cwd().
  cwd?: string;
}

export async function createStdioTransport(opts: StdioTransportOptions = {}): Promise<Transport> {
  // Lazy-import so the WebSocket-only build (Vercel / browser bundle)
  // doesn't pull child_process into its dep graph.
  const { spawn } = await import("node:child_process");
  const command = opts.command || process.env.CODEX_BIN || "codex";
  const args = opts.args || ["app-server"];

  const child = spawn(command, args, {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout) {
    try { child.kill("SIGTERM"); } catch {}
    throw new Error(`Failed to attach to ${command} stdio`);
  }

  const messageHandlers: ((env: any) => void)[] = [];
  const closeHandlers: ((err?: Error) => void)[] = [];
  let buffer = "";
  let closed = false;

  // Wait for spawn to actually succeed (or fail fast on ENOENT).
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (e: any) => {
      if (settled) return;
      settled = true;
      // ENOENT = binary not found. Convert to a user-actionable message.
      if (e?.code === "ENOENT") {
        reject(new Error(`Codex binary not found on PATH. Install it from https://github.com/openai/codex or set the CODEX_BIN env var.`));
      } else {
        reject(new Error(`Failed to launch ${command}: ${e?.message || "unknown error"}`));
      }
    };
    child.once("error", onError);
    // If spawn() goes through without an immediate error within ~300ms,
    // assume the process is up.
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off("error", onError);
      resolve();
    }, 300);
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      child.off("error", onError);
      resolve();
    });
  });

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const env = JSON.parse(line);
        for (const h of messageHandlers) h(env);
      } catch {
        // Drop malformed frames silently — never log raw bytes.
      }
    }
  });

  // Forward stderr lines as `log` notifications. We synthesise a
  // JSON-RPC notification envelope so the AppServerClient's existing
  // log-handler path picks them up.
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => {
    const lines = String(chunk).split("\n").map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      // Cap line length so a runaway log can't blow up our trace store.
      const trimmed = line.length > 1000 ? line.slice(0, 1000) + " …(truncated)" : line;
      const level = /\b(error|fatal)\b/i.test(line) ? "error"
                  : /\b(warn|warning)\b/i.test(line) ? "warn" : "info";
      for (const h of messageHandlers) {
        try {
          h({ jsonrpc: "2.0", method: "log", params: { level, message: trimmed, source: "codex-stderr" } });
        } catch {}
      }
    }
  });

  // Fire close handlers exactly once on either child exit or transport
  // .close() — but never twice. We track a separate flag so the user-
  // initiated close() path can also drive the fan-out (the previous
  // version short-circuited inside this `child.once("close")` whenever
  // `closed=true` was set by close(), which silently dropped the
  // notifications).
  let handlersFired = false;
  function fireClose(err?: Error) {
    if (handlersFired) return;
    handlersFired = true;
    for (const h of closeHandlers) {
      try { h(err); } catch {}
    }
  }
  child.once("close", (code) => {
    closed = true;
    const err = code === 0 || code === null
      ? undefined
      : new Error(`codex app-server exited with code ${code}`);
    fireClose(err);
  });
  child.once("error", (e) => {
    closed = true;
    fireClose(new Error(`codex app-server error: ${e?.message || "unknown"}`));
  });

  return {
    async send(envelope: any) {
      if (closed) throw new Error("codex app-server is no longer running");
      const frame = JSON.stringify(envelope) + "\n";
      child.stdin!.write(frame);
    },
    onMessage(h) { messageHandlers.push(h); },
    onClose(h) { closeHandlers.push(h); },
    async close() {
      if (closed && handlersFired) return;
      closed = true;
      try {
        child.stdin?.end();
        // Give it a moment to exit gracefully, then SIGTERM.
        const t = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 500);
        await new Promise<void>(resolve => {
          if (handlersFired) { resolve(); return; }
          // Either the child's "close" event fires (which fireClose above
          // will resolve), or our hard cap kicks in — in both cases we
          // also call fireClose() defensively so any subscribers see the
          // shutdown.
          const onClose = () => { clearTimeout(t); fireClose(); resolve(); };
          child.once("close", onClose);
          setTimeout(() => { fireClose(); resolve(); }, 2000);
        });
      } catch {}
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function isLoopback(host: string): boolean {
  return host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || host.endsWith(".localhost");
}

// Local re-import to avoid circular deps in the redact pass above.
// (transport.ts only redacts strings for error messages, not envelopes.)
function redactString(s: string): string {
  // intentionally light — full redactor is in ./redact.ts
  return s.replace(/\?[^\s"']+/g, "?[REDACTED]");
}

// Re-export for symmetry. The full client uses redactRpcEnvelope from redact.ts.
export { redactRpcEnvelope };
