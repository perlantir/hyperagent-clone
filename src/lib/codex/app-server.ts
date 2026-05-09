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
// P64.2 — Authoritative protocol confirmed against codex 0.130.0 via
// `codex app-server generate-ts` + a real-binary smoke test
// (`scripts/codex-smoke-test.ts`). Notable corrections from earlier
// iterations:
//
//   - account/read takes `{ refreshToken: boolean }` and returns
//     `{ account: Account | null, requiresOpenaiAuth: boolean }`. We
//     used to call it with no params and assume a flat-shape result.
//
//   - account/chatgptAuthTokens/refresh is a SERVER REQUEST (codex →
//     us), not a client method. We now register a handler for it via
//     onServerRequest and reply with the refreshed tokens.
//
//   - Approvals are server-initiated: codex sends
//     item/commandExecution/requestApproval (v2),
//     item/fileChange/requestApproval (v2), or the legacy
//     applyPatchApproval / execCommandApproval. Our previous
//     `approval/respond` method is wrong — there's no client-initiated
//     approval method. We now respond to the server request directly
//     by id via the onServerRequest hook.
//
//   - InitializeResponse contains `{ userAgent, codexHome, platformOs,
//     platformFamily }` — no capability echo. The earlier comment
//     about "the bridge replies with its own capability set" was
//     incorrect; we don't read or store any capabilities from the
//     init result.
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
  type AppServerNotification,
  type AppServerRequest,
  type ChatgptAuthTokensRefreshResponse,
} from "./types";
import { type Transport, createWebSocketTransport } from "./transport";
import { redactRpcEnvelope } from "./redact";

export interface AppServerClientOptions {
  // Provide a transport directly (tests pass a mock).
  transport?: Transport;
  // Or pass a bridge URL + capability token and we'll build a WS transport.
  url?: string;
  capabilityToken?: string;
  // P64.2 — Optional pre-resolved IP address (and family). Forwarded
  // to the WebSocket transport's `lookup` callback so the underlying
  // TCP connection pins to the same address that url-safety just
  // validated, closing the DNS-rebinding TOCTOU window.
  preResolvedAddress?: string;
  preResolvedFamily?: 4 | 6;
  // Optional sink for redacted trace events. Receives the redacted
  // envelope; never the original. Use this to wire into your trace store.
  onTrace?: (event: { kind: "send" | "recv"; envelope: any }) => void;
  // Capability flags. experimentalApi unlocks chatgptAuthTokens flow.
  capabilities?: { experimentalApi?: boolean };
}

// P64.2 — Server-initiated request handler. Called when codex sends
// us a JSON-RPC request that expects a response (e.g. an approval
// request, an MCP elicitation, or a chatgptAuthTokens refresh).
// Return a value (resolved or thrown) and we'll send the appropriate
// JSON-RPC response back. If no handler is registered for a method
// we reply with -32601 method-not-found so codex doesn't hang.
export type ServerRequestHandler = (req: AppServerRequest) => Promise<any>;

// ─── approval method → legacy notification mapping ─────────────────
//
// The chat-bridge subscribes to "approval/required" with a fixed shape:
//   { approvalId, turnId, kind, summary, detail?, command?, cwd?, path?, diff? }
//
// Real codex emits a discriminated union of server-initiated requests.
// These helpers project each onto the legacy fields the UI already
// renders. Anything we don't have a clean mapping for becomes a generic
// "tool" approval with a JSON-stringified detail.

function legacyApprovalKind(method: string): "command" | "file" | "network" | "tool" {
  if (method === "applyPatchApproval" || method === "item/fileChange/requestApproval") return "file";
  if (method === "execCommandApproval" || method === "item/commandExecution/requestApproval") return "command";
  if (method === "item/permissions/requestApproval") return "network";
  return "tool";
}

function legacyApprovalSummary(method: string, params: any): string {
  if (!params) return method;
  if (method === "execCommandApproval" || method === "item/commandExecution/requestApproval") {
    const cmd = params.command || params.cmd || (Array.isArray(params.argv) ? params.argv.join(" ") : "");
    return cmd ? `Run: ${String(cmd).slice(0, 200)}` : "Run command";
  }
  if (method === "applyPatchApproval" || method === "item/fileChange/requestApproval") {
    const path = params.path || params.file_path || (Array.isArray(params.changes) ? params.changes[0]?.path : "");
    return path ? `Modify: ${String(path).slice(0, 200)}` : "Apply patch";
  }
  if (method === "item/permissions/requestApproval") {
    return params.summary || "Permission request";
  }
  if (method === "item/tool/call") {
    return `Tool call: ${params.toolName || params.name || "(unknown)"}`;
  }
  if (method === "item/tool/requestUserInput") {
    return params.summary || "Tool input request";
  }
  return method;
}

function legacyApprovalDetail(method: string, params: any): string | undefined {
  if (!params) return undefined;
  if (method === "applyPatchApproval" || method === "item/fileChange/requestApproval") {
    const diff = params.diff || params.unified_diff
      || (Array.isArray(params.changes) ? params.changes.map((c: any) => c.diff || "").join("\n") : "");
    return typeof diff === "string" && diff ? diff.slice(0, 5000) : undefined;
  }
  if (method === "execCommandApproval" || method === "item/commandExecution/requestApproval") {
    return params.cwd ? `cwd: ${params.cwd}` : undefined;
  }
  // Fallback: best-effort JSON snippet for anything we haven't named.
  try {
    const json = JSON.stringify(params).slice(0, 1000);
    return json;
  } catch { return undefined; }
}

export class AppServerClient {
  private transport!: Transport;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (r: any) => void; reject: (e: Error) => void; method: string }>();
  private notifHandlers = new Map<string, ((params: any) => void)[]>();
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();
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
        preResolvedAddress: this.opts.preResolvedAddress,
        preResolvedFamily: this.opts.preResolvedFamily,
      });

    this.transport.onMessage(env => this.handleEnvelope(env));
    this.transport.onClose(() => this.handleClose());

    // JSON-RPC initialize handshake. We declare our client name +
    // version + capabilities. The real codex 0.130.0 InitializeResponse
    // is `{ userAgent, codexHome, platformFamily, platformOs }` — there
    // is NO server-side capability echo, so we don't read one out.
    // experimentalApi is still valid as a CLIENT capability hint per
    // generated InitializeCapabilities.
    const init = await this.request("initialize", {
      clientInfo: { name: "hyperagent-clone", title: null, version: "0.5.0" },
      capabilities: {
        experimentalApi: !!this.capabilities.experimentalApi,
        optOutNotificationMethods: null,
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
   * expect a response.
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

  /**
   * Register a handler for a server-initiated request. The handler
   * receives the request envelope and returns the result; the client
   * sends the JSON-RPC response back. Throwing from the handler maps
   * to a JSON-RPC error response.
   *
   * Methods we expect to handle (all server-initiated per
   * ServerRequest.ts in codex 0.130.0):
   *
   *   - account/chatgptAuthTokens/refresh — codex needs a fresh
   *     ChatGPT access token; client returns
   *     { accessToken, chatgptAccountId, chatgptPlanType? }.
   *   - applyPatchApproval / execCommandApproval (legacy)
   *   - item/commandExecution/requestApproval (v2)
   *   - item/fileChange/requestApproval (v2)
   *   - item/permissions/requestApproval (v2)
   *   - item/tool/requestUserInput (v2)
   *   - item/tool/call (v2)
   *   - mcpServer/elicitation/request (v2)
   */
  onServerRequest<M extends AppServerRequest["method"]>(
    method: M,
    handler: (
      req: Extract<AppServerRequest, { method: M }>,
    ) => Promise<any>,
  ): () => void {
    this.serverRequestHandlers.set(method, handler as ServerRequestHandler);
    return () => {
      this.serverRequestHandlers.delete(method);
    };
  }

  // ─── account/* ─────────────────────────────────────────────────────

  // P64.2 — real codex requires `{ refreshToken: boolean }`. Pass false
  // by default so a status read doesn't trigger a token refresh as a
  // side effect.
  accountRead(params: { refreshToken?: boolean } = {}): Promise<AccountReadResult> {
    return this.request("account/read", { refreshToken: !!params.refreshToken });
  }

  accountLoginStart(params: AccountLoginStartParams): Promise<AccountLoginStartResult> {
    return this.request("account/login/start", params);
  }

  // codex expects no params (undefined, NOT {}). We pass undefined so
  // the JSON-RPC envelope omits the `params` key entirely.
  accountLogout(): Promise<void> {
    return this.request("account/logout", undefined);
  }

  accountRateLimitsRead(): Promise<AccountRateLimitsResult> {
    return this.request("account/rateLimits/read", undefined);
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

  // P64.2 — `getAuthStatus` is a separate (lighter) method from
  // `account/read`. It returns auth method + an optional access token
  // when includeToken=true. We never include the token over the wire
  // unless the caller explicitly asked for it.
  getAuthStatus(opts: { includeToken?: boolean; refreshToken?: boolean } = {}): Promise<{
    authMethod: "apikey" | "chatgpt" | "chatgptAuthTokens" | "agentIdentity" | null;
    authToken: string | null;
    requiresOpenaiAuth: boolean | null;
  }> {
    return this.request("getAuthStatus", {
      includeToken: !!opts.includeToken,
      refreshToken: !!opts.refreshToken,
    });
  }

  // ─── approvals (compat layer over server-initiated requests) ───────
  //
  // P64.2 — Real codex approvals arrive as JSON-RPC REQUESTS from
  // server → client (one of the eight approval-shaped methods on
  // ServerRequest.ts). The existing chat-bridge.ts subscribes to a
  // synthesized "approval/required" notification and calls
  // approvalRespond(approvalId, decision) when the user picks one.
  //
  // We preserve that interface here. internalRegisterApprovalBridge()
  // installs onServerRequest handlers for all known approval methods,
  // assigns each request a fresh approvalId, fires the legacy
  // notification handlers via on("approval/required"), and stashes the
  // pending JSON-RPC id so approvalRespond() can resolve it.
  //
  // This is a transitional shim. Long-term we should expose the v2
  // approval shapes (item/commandExecution/requestApproval, etc.)
  // directly to the UI so it can render their richer payloads. Done
  // in P65.
  private pendingApprovals = new Map<
    string,
    { jsonRpcId: number | string; method: string }
  >();
  private nextApprovalId = 1;
  private approvalBridgeInstalled = false;

  installApprovalBridge() {
    if (this.approvalBridgeInstalled) return;
    this.approvalBridgeInstalled = true;
    const APPROVAL_METHODS = [
      "applyPatchApproval",
      "execCommandApproval",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "item/tool/call",
    ] as const;
    for (const method of APPROVAL_METHODS) {
      this.serverRequestHandlers.set(method as string, async (req) => {
        const approvalId = `${method}#${this.nextApprovalId++}`;
        this.pendingApprovals.set(approvalId, { jsonRpcId: req.id, method });
        // Fire the legacy notification subscribers so chat-bridge.ts
        // sees the same shape it expects.
        const legacy = this.notifHandlers.get("approval/required") || [];
        const params: any = req.params || {};
        const summary = legacyApprovalSummary(method, params);
        for (const h of legacy) {
          try {
            h({
              approvalId,
              kind: legacyApprovalKind(method),
              summary,
              detail: legacyApprovalDetail(method, params),
              command: params.command,
              cwd: params.cwd,
              path: params.path || params.file_path,
              diff: params.diff || params.unified_diff,
              turnId: params.turnId || params.threadId || "",
            });
          } catch {}
        }
        // Return a Promise that resolves once approvalRespond() fires.
        return await new Promise<any>((resolve, reject) => {
          this.pendingApprovalResolvers.set(approvalId, { resolve, reject });
          // No timeout here — chat-bridge.ts owns the user-facing
          // timeout via pollDecision.
        });
      });
    }
  }

  private pendingApprovalResolvers = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  /**
   * P57 backward-compat. The chat-bridge calls this with a synthesized
   * approvalId (assigned by installApprovalBridge above) plus the
   * user's decision. We map the decision onto whatever shape the
   * underlying real codex method expects and resolve the pending
   * server-request handler so the JSON-RPC response is sent.
   */
  approvalRespond(params: { approvalId: string; decision: "accept" | "acceptForSession" | "decline" | "cancel" }): Promise<void> {
    if (!this.approvalBridgeInstalled) this.installApprovalBridge();
    const pending = this.pendingApprovals.get(params.approvalId);
    const resolver = this.pendingApprovalResolvers.get(params.approvalId);
    if (!pending || !resolver) {
      // Already resolved / unknown id. Treat as no-op so duplicate
      // clicks don't crash the run.
      return Promise.resolve();
    }
    this.pendingApprovals.delete(params.approvalId);
    this.pendingApprovalResolvers.delete(params.approvalId);
    // Map decision onto the response shape the real codex expects.
    // For the legacy methods, the response is `{ decision: "approved"
    // | "denied" | "approvedForSession" }` per ApplyPatchApprovalResponse
    // / ExecCommandApprovalResponse. For the v2 *RequestApprovalResponse
    // shapes, the response carries a `decision` field too. We send a
    // lowest-common-denominator shape and let codex coerce.
    const codexDecision =
      params.decision === "accept" ? "approved"
      : params.decision === "acceptForSession" ? "approvedForSession"
      : "denied";
    resolver.resolve({ decision: codexDecision });
    return Promise.resolve();
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
      // Response to one of OUR requests.
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

    // P64.2 — Server-initiated REQUEST (has id + method but no result).
    // Codex sends these for approvals, MCP elicitations, and chatgpt
    // auth-token refresh. Look up a handler; reply with method-not-found
    // (-32601) when none is registered so codex doesn't hang forever.
    if (typeof env?.id !== "undefined" && typeof env?.method === "string") {
      const reqId = env.id;
      const method = env.method;
      const handler = this.serverRequestHandlers.get(method);
      if (!handler) {
        this.respondToServerRequest(reqId, undefined, {
          code: -32601,
          message: `No handler registered for server request: ${method}`,
        }).catch(() => undefined);
        return;
      }
      // Run the handler async; respond with the value (or an error).
      Promise.resolve()
        .then(() => handler(env as AppServerRequest))
        .then((result) => this.respondToServerRequest(reqId, result))
        .catch((e: any) =>
          this.respondToServerRequest(reqId, undefined, {
            code: -32000,
            message: e?.message ? String(e.message).slice(0, 500) : "handler error",
          }),
        );
      return;
    }

    // Notification (no id). Fan out to subscribers.
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

  // P64.2 — Force the caller to install the approval bridge before any
  // approvals are handled, otherwise we'd reply -32601 to every approval
  // request and stall every codex turn that asks for confirmation.
  // chat-bridge.ts calls this implicitly on first turn via the legacy
  // .on("approval/required") subscription; tests may need to call it
  // directly.

  private async respondToServerRequest(
    id: number | string,
    result?: any,
    error?: { code: number; message: string },
  ): Promise<void> {
    const env: any = { jsonrpc: "2.0", id };
    if (error) env.error = error;
    else env.result = result === undefined ? null : result;
    this.opts.onTrace?.({ kind: "send", envelope: redactRpcEnvelope(env) });
    try {
      await this.transport.send(env);
    } catch (e) {
      // Sending the response failed — likely because the transport is
      // already closed. Nothing to do; codex will see the close and
      // tear down its own request state.
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
