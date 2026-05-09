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

// ─── Stdio transport (stub) ──────────────────────────────────────────
//
// Spawns `codex app-server` as a child process. Only viable on a
// long-lived host. Implemented as a stub so callers can detect it
// returns false; building the actual child_process implementation is
// gated behind RUNTIME=node-server.

export interface StdioTransportOptions {
  command?: string;        // default: "codex"
  args?: string[];         // default: ["app-server"]
  env?: Record<string, string>;
}

export async function createStdioTransport(_opts: StdioTransportOptions = {}): Promise<Transport> {
  throw new Error(
    "Codex stdio transport is not available in this runtime. Run a Codex app-server bridge with `codex app-server --listen 127.0.0.1:<port>` and configure its WebSocket URL in Settings → Codex.",
  );
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
