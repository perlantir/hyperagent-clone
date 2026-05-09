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
// We deliberately use the platform's WebSocket (Node 18+ / browser) so
// the same code runs from a serverless route or a Node background
// worker. Authentication is done via the Sec-WebSocket-Protocol header
// because that's the cleanest path through edge proxies; capability
// tokens go through the subprotocol slot rather than Authorization.
//
// SECURITY: We refuse to connect to ws:// for non-loopback hosts and
// require wss:// otherwise.

export interface WebSocketTransportOptions {
  url: string;
  capabilityToken: string;
  // Allow callers to pass a custom WebSocket impl for tests.
  webSocketImpl?: any;
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

  const WebSocketImpl: any = opts.webSocketImpl
    || (typeof WebSocket !== "undefined" ? WebSocket : null);
  if (!WebSocketImpl) {
    throw new Error("No WebSocket implementation available in this runtime");
  }

  // Use the standard subprotocol slot to carry the capability token.
  // bridges that follow this convention parse it as `bearer.<token>`.
  const subProtocol = `codex-bridge.bearer.${opts.capabilityToken}`;
  const ws = new WebSocketImpl(opts.url, [subProtocol]);

  const messageHandlers: ((env: any) => void)[] = [];
  const closeHandlers: ((err?: Error) => void)[] = [];
  let buffer = "";
  let closed = false;

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Codex bridge connection timed out")), 8000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (e: any) => { clearTimeout(t); reject(new Error(`Codex bridge connection error: ${e?.message || "unknown"}`)); };
  });

  ws.onmessage = (ev: any) => {
    const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
    buffer += data;
    // Frame on newlines.
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
  };
  ws.onclose = () => {
    if (closed) return;
    closed = true;
    for (const h of closeHandlers) h();
  };
  ws.onerror = (_e: any) => {
    if (closed) return;
    closed = true;
    // We DON'T forward the underlying event — it may carry callback URLs.
    for (const h of closeHandlers) h(new Error("Codex bridge socket error"));
  };

  return {
    async send(envelope: any) {
      const frame = JSON.stringify(envelope) + "\n";
      ws.send(frame);
    },
    onMessage(h) { messageHandlers.push(h); },
    onClose(h) { closeHandlers.push(h); },
    async close() {
      if (closed) return;
      closed = true;
      try { ws.close(1000, "client_close"); } catch {}
    },
  };
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
