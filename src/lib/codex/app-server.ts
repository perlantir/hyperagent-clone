// P57 — Codex app-server JSON-RPC 2.0 client.
//
// Connects to a Codex bridge over a Transport (WebSocket today; stdio
// later) and exposes the high-level methods our app calls: account/read,
// account/login/start, account/logout, account/rateLimits/read,
// thread/start, turn/start.
//
// The client multiplexes requests on numeric ids and routes responses
// back to the awaiting promise. Server-initiated notifications (turn
// events, approval requests, log lines) are forwarded to the per-method
// listeners callers can subscribe to.
//
// IMPORTANT: Every envelope that reaches a logger / trace emitter is
// passed through redactRpcEnvelope first. The client itself never logs
// raw envelopes.

import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type AccountReadResult,
  type AccountLoginStartParams,
  type AccountLoginStartResult,
  type AccountRateLimitsResult,
  type ThreadStartParams,
  type ThreadStartResult,
  type TurnStartParams,
  type TurnStartResult,
  type ApprovalRespondParams,
  type AppServerNotification,
} from "./types";
import { type Transport, createWebSocketTransport } from "./transport";
import { redactRpcEnvelope } from "./redact";

export interface AppServerClientOptions {
  // Provide a transport directly (tests pass a mock).
  transport?: Transport;
  // Or pass a bridge URL + capability token and we'll build a WS transport.
  url?: string;
  capabilityToken?: string;
  // Optional sink for redacted trace events. Receives the redacted
  // envelope; never the original. Use this to wire into your trace store.
  onTrace?: (event: { kind: "send" | "recv"; envelope: any }) => void;
  // Capability flags. experimentalApi unlocks chatgptAuthTokens flow.
  capabilities?: { experimentalApi?: boolean };
}

export class AppServerClient {
  private transport!: Transport;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (r: any) => void; reject: (e: Error) => void; method: string }>();
  private notifHandlers = new Map<string, ((params: any) => void)[]>();
  private opts: AppServerClientOptions;
  private connected = false;
  private capabilities: { experimentalApi?: boolean } = {};

  constructor(opts: AppServerClientOptions) {
    this.opts = opts;
    this.capabilities = opts.capabilities || {};
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.transport = this.opts.transport
      || await createWebSocketTransport({
        url: this.opts.url!,
        capabilityToken: this.opts.capabilityToken!,
      });

    this.transport.onMessage(env => this.handleEnvelope(env));
    this.transport.onClose(() => this.handleClose());

    // JSON-RPC initialize handshake. We declare our capabilities and the
    // client name; the bridge replies with its own capability set, which
    // we record so the UI can branch on (e.g. show a "Codex >= 1.5" hint).
    const init = await this.request("initialize", {
      clientInfo: { name: "hyperagent-clone", version: "0.5.0" },
      capabilities: {
        // experimentalApi gates the chatgptAuthTokens flow per spec.
        experimentalApi: !!this.capabilities.experimentalApi,
      },
    }, { timeoutMs: 10_000 });

    this.connected = true;
    return init;
  }

  async close(): Promise<void> {
    if (!this.transport) return;
    this.connected = false;
    for (const [, p] of this.pending) {
      p.reject(new Error("Codex bridge connection closed"));
    }
    this.pending.clear();
    await this.transport.close();
  }

  /**
   * Subscribe to notifications by method name. Returns an unsubscribe fn.
   * Notifications are server-initiated — they have no `id` and don't
   * expect a response (except approval/required, which is handled via the
   * separate approval/respond request).
   */
  on<M extends AppServerNotification["method"]>(
    method: M,
    handler: (params: Extract<AppServerNotification, { method: M }>["params"]) => void,
  ): () => void {
    const list = this.notifHandlers.get(method) || [];
    list.push(handler as any);
    this.notifHandlers.set(method, list);
    return () => {
      const cur = this.notifHandlers.get(method) || [];
      this.notifHandlers.set(method, cur.filter(h => h !== handler));
    };
  }

  // ─── account/* ─────────────────────────────────────────────────────

  accountRead(): Promise<AccountReadResult> {
    return this.request("account/read");
  }

  accountLoginStart(params: AccountLoginStartParams): Promise<AccountLoginStartResult> {
    return this.request("account/login/start", params);
  }

  accountLogout(): Promise<void> {
    return this.request("account/logout");
  }

  accountRateLimitsRead(): Promise<AccountRateLimitsResult> {
    return this.request("account/rateLimits/read");
  }

  // EXPERIMENTAL — only callable when capabilities.experimentalApi is true.
  // Used by the bridge to refresh ChatGPT tokens. We never persist the
  // returned tokens; the bridge owns its own storage.
  accountChatgptAuthTokensRefresh(): Promise<{ ok: boolean }> {
    if (!this.capabilities.experimentalApi) {
      throw new Error("chatgptAuthTokens flow requires capabilities.experimentalApi = true");
    }
    return this.request("account/chatgptAuthTokens/refresh");
  }

  // ─── thread / turn ─────────────────────────────────────────────────

  threadStart(params: ThreadStartParams = {}): Promise<ThreadStartResult> {
    return this.request("thread/start", params);
  }

  turnStart(params: TurnStartParams): Promise<TurnStartResult> {
    return this.request("turn/start", params);
  }

  threadFork(threadId: string): Promise<ThreadStartResult> {
    return this.request("thread/fork", { threadId });
  }

  // ─── approval ──────────────────────────────────────────────────────
  //
  // Send the user's decision back to app-server. Trace decisions but
  // never the raw approval payload (which may contain commands / paths).

  approvalRespond(params: ApprovalRespondParams): Promise<void> {
    return this.request("approval/respond", params);
  }

  // ─── private ───────────────────────────────────────────────────────

  private async request(method: string, params?: any, opts: { timeoutMs?: number } = {}): Promise<any> {
    if (!this.transport) throw new Error("AppServerClient.connect() must be called first");
    const id = this.nextId++;
    const env: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    // Trace BEFORE sending. We pass through the redactor so the upstream
    // sink never sees raw API keys / verifiers / etc.
    this.opts.onTrace?.({ kind: "send", envelope: redactRpcEnvelope(env) });

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, opts.timeoutMs || 30_000);

      this.pending.set(id, {
        method,
        resolve: r => { clearTimeout(timer); resolve(r); },
        reject: e => { clearTimeout(timer); reject(e); },
      });

      this.transport.send(env).catch(e => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  private handleEnvelope(env: any) {
    // Trace EVERY incoming envelope, redacted.
    this.opts.onTrace?.({ kind: "recv", envelope: redactRpcEnvelope(env) });

    if (typeof env?.id !== "undefined" && (env.result !== undefined || env.error !== undefined)) {
      // Response.
      const p = this.pending.get(env.id);
      if (!p) return; // late or unmatched
      this.pending.delete(env.id);
      const resp = env as JsonRpcResponse;
      if (resp.error) {
        // Error message is redacted via the trace pass already. Construct
        // a fresh Error so the original (possibly-sensitive) string never
        // leaks through stack-attached properties.
        p.reject(Object.assign(new Error(`Codex ${p.method} failed: ${(redactRpcEnvelope(env) as any).error?.message || "unknown"}`), {
          codexCode: resp.error.code,
        }));
      } else {
        p.resolve(resp.result);
      }
      return;
    }

    // Notification. Fan out to subscribers.
    if (typeof env?.method === "string") {
      const notif = env as JsonRpcNotification;
      const handlers = this.notifHandlers.get(notif.method) || [];
      for (const h of handlers) {
        try { h(notif.params); }
        catch (e) {
          // Don't let one handler break the dispatch loop.
          console.error(`[codex] notification handler for ${notif.method} threw`, e);
        }
      }
    }
  }

  private handleClose() {
    this.connected = false;
    for (const [, p] of this.pending) {
      p.reject(new Error("Codex bridge connection closed"));
    }
    this.pending.clear();
    // Tell subscribers we're done so they can teardown.
    const handlers = this.notifHandlers.get("__close__" as any) || [];
    for (const h of handlers) try { h({}); } catch {}
  }
}
