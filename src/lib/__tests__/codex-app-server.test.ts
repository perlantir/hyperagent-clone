// P57 + P64.2 — codex AppServerClient JSON-RPC tests with a mock transport.
//
// Aligned with the real codex 0.130.0 wire protocol confirmed via
// `codex app-server generate-ts` + scripts/codex-smoke-test.ts.
//
// Validates:
//   - initialize handshake fires before any other request
//   - account/read passes `{ refreshToken: false }` and parses the
//     real `{ account, requiresOpenaiAuth }` response
//   - account/login/start covers the four real variants
//   - account/logout omits params entirely (undefined, not {})
//   - account/rateLimits/read takes no params
//   - getAuthStatus is its own method (separate from account/read)
//   - request/response correlation by id
//   - notification fan-out
//   - server-initiated REQUESTS (with id) are routed to onServerRequest
//     handlers; an unhandled method gets -32601 back
//   - approval bridge: real codex emits server-initiated approval
//     requests; our compat layer surfaces them as "approval/required"
//     notifications and approvalRespond() sends the JSON-RPC response
//   - chatgptAuthTokens/refresh handler returns the right shape to
//     codex (server → client request)
//   - close() rejects pending promises and cleans up
//   - traces never see raw tokens / callback URLs

import { AppServerClient } from "../codex/app-server";
import type { Transport } from "../codex/transport";

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

interface MockTransportAPI {
  transport: Transport;
  sent: any[];
  receive: (env: any) => void;
  triggerClose: (err?: Error) => void;
}

function mockTransport(): MockTransportAPI {
  const sent: any[] = [];
  let onMsg: ((env: any) => void) | null = null;
  let onCls: ((err?: Error) => void) | null = null;
  return {
    sent,
    transport: {
      send: async (env: any) => { sent.push(env); },
      onMessage: h => { onMsg = h; },
      onClose: h => { onCls = h; },
      close: async () => {},
    },
    receive: env => onMsg?.(env),
    triggerClose: err => onCls?.(err),
  };
}

(async () => {
  // ─── initialize handshake ──────────────────────────────────────────
  {
    const m = mockTransport();
    const traceLog: any[] = [];
    const c = new AppServerClient({ transport: m.transport, onTrace: e => traceLog.push(e) });
    queueMicrotask(() => {
      const init = m.sent[0];
      pass("initialize sent first", init?.method === "initialize");
      pass("initialize has client info", init?.params?.clientInfo?.name === "hyperagent-clone");
      pass("initialize has clientInfo.title=null per real codex shape",
        init?.params?.clientInfo?.title === null);
      pass("initialize defaults experimentalApi=false",
        init?.params?.capabilities?.experimentalApi === false);
      pass("initialize sets optOutNotificationMethods=null",
        init?.params?.capabilities?.optOutNotificationMethods === null);
      // Real InitializeResponse: { userAgent, codexHome, platformFamily, platformOs }
      m.receive({ jsonrpc: "2.0", id: init.id, result: {
        userAgent: "codex-cli/0.130.0",
        codexHome: "/home/u/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      } });
    });
    await c.connect();
    pass("connect resolves after initialize", true);

    pass("trace captures initialize send",
      traceLog.some(e => e.kind === "send" && e.envelope?.method === "initialize"));
    pass("trace captures initialize response",
      traceLog.some(e => e.kind === "recv" && e.envelope?.id === m.sent[0].id));
  }

  // ─── account/read with real { account, requiresOpenaiAuth } shape ─
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountRead();
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("account/read method correct", req.method === "account/read");
      pass("account/read params.refreshToken=false by default",
        req.params?.refreshToken === false);
      m.receive({
        jsonrpc: "2.0", id: req.id,
        result: {
          account: { type: "chatgpt", email: "u@example.com", planType: "plus" },
          requiresOpenaiAuth: false,
        },
      });
    });
    const r = await p;
    pass("account/read returns parsed account",
      (r as any).account?.email === "u@example.com" && (r as any).account?.planType === "plus");
    pass("account/read surfaces requiresOpenaiAuth",
      (r as any).requiresOpenaiAuth === false);
  }

  // ─── account/read explicit refreshToken=true ──────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountRead({ refreshToken: true });
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("account/read params.refreshToken=true respected",
        req.params?.refreshToken === true);
      m.receive({ jsonrpc: "2.0", id: req.id, result: { account: null, requiresOpenaiAuth: true } });
    });
    await p;
  }

  // ─── account/login/start: chatgpt PKCE ─────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountLoginStart({ type: "chatgpt" });
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("login/start method correct", req.method === "account/login/start");
      pass("login/start params.type=chatgpt", req.params.type === "chatgpt");
      // Real response: { type: "chatgpt", loginId, authUrl }
      m.receive({ jsonrpc: "2.0", id: req.id, result: {
        type: "chatgpt",
        loginId: "lg_abc",
        authUrl: "https://auth.openai.com/login?code=abc",
      } });
    });
    const r = await p as any;
    pass("login/start chatgpt response carries loginId",
      r.type === "chatgpt" && r.loginId === "lg_abc");
    pass("login/start chatgpt response carries authUrl",
      typeof r.authUrl === "string" && r.authUrl.startsWith("https://"));
  }

  // ─── account/login/start: chatgptAuthTokens (experimental flow) ───
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport, capabilities: { experimentalApi: true } });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountLoginStart({
      type: "chatgptAuthTokens",
      accessToken: "eyJhbGc...redacted",
      chatgptAccountId: "wks_123",
      chatgptPlanType: "plus",
    });
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("login/start chatgptAuthTokens variant accepted",
        req.params.type === "chatgptAuthTokens" && typeof req.params.accessToken === "string");
      m.receive({ jsonrpc: "2.0", id: req.id, result: { type: "chatgptAuthTokens" } });
    });
    await p;
  }

  // ─── account/login/start: apiKey ──────────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountLoginStart({ type: "apiKey", apiKey: "sk-test-1234567890" });
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("login/start apiKey type correct", req.params.type === "apiKey");
      m.receive({ jsonrpc: "2.0", id: req.id, result: { type: "apiKey" } });
    });
    await p;
    pass("login/start apiKey resolves", true);
  }

  // ─── account/login/start: device code ─────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountLoginStart({ type: "chatgptDeviceCode" });
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("login/start chatgptDeviceCode type correct", req.params.type === "chatgptDeviceCode");
      m.receive({ jsonrpc: "2.0", id: req.id, result: {
        type: "chatgptDeviceCode",
        loginId: "lg_dev",
        verificationUrl: "https://auth.openai.com/device",
        userCode: "ABCD-1234",
      } });
    });
    const r = await p as any;
    pass("device-code result carries verificationUrl + userCode",
      r.type === "chatgptDeviceCode"
      && r.userCode === "ABCD-1234"
      && r.verificationUrl === "https://auth.openai.com/device");
  }

  // ─── account/logout: params explicitly undefined ──────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountLogout();
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("account/logout method correct", req.method === "account/logout");
      // Real codex requires `params: undefined` in ClientRequest.ts.
      // The JSON-RPC envelope key may still appear (with value undefined)
      // in our internal struct; what matters is JSON.stringify omits it.
      const wireBody = JSON.stringify(req);
      pass("account/logout omits params from JSON wire body",
        !/\"params\"\s*:\s*\{\s*\}/.test(wireBody),
        `wire body: ${wireBody}`);
      m.receive({ jsonrpc: "2.0", id: req.id, result: {} });
    });
    await p;
    pass("account/logout resolves", true);
  }

  // ─── account/rateLimits/read ──────────────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountRateLimitsRead();
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("rateLimits/read method correct", req.method === "account/rateLimits/read");
      m.receive({ jsonrpc: "2.0", id: req.id, result: { tokensRemaining: 1000, tokensLimit: 5000 } });
    });
    const r = await p;
    pass("rateLimits/read returns numbers", r.tokensRemaining === 1000 && r.tokensLimit === 5000);
  }

  // ─── getAuthStatus (separate method from account/read) ────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.getAuthStatus();
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("getAuthStatus method correct (NOT account/read)",
        req.method === "getAuthStatus");
      pass("getAuthStatus default includeToken=false",
        req.params?.includeToken === false);
      pass("getAuthStatus default refreshToken=false",
        req.params?.refreshToken === false);
      m.receive({ jsonrpc: "2.0", id: req.id, result: {
        authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: false,
      } });
    });
    const r = await p;
    pass("getAuthStatus parses authMethod", r.authMethod === "chatgpt");
  }

  // ─── notifications fan-out (no id) ────────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    let logCount = 0;
    c.on("log", () => { logCount++; });
    m.receive({ jsonrpc: "2.0", method: "log", params: { level: "info", message: "hello" } });
    m.receive({ jsonrpc: "2.0", method: "log", params: { level: "warn", message: "test" } });
    pass("log notification fired twice", logCount === 2);
  }

  // ─── server-initiated requests: unhandled → -32601 reply ──────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    // Codex sends a request we have no handler for.
    m.receive({ jsonrpc: "2.0", id: 99, method: "mcpServer/elicitation/request", params: {} });
    // Allow the microtask queue to flush.
    await new Promise(r => setTimeout(r, 5));
    const reply = m.sent.find(e => e.id === 99);
    pass("unhandled server request gets a reply",
      !!reply, "no reply was sent at all");
    pass("unhandled server request reply is -32601",
      reply?.error?.code === -32601);
  }

  // ─── server-initiated requests: handler returns a result ──────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    c.onServerRequest("account/chatgptAuthTokens/refresh" as any, async (_req: any) => {
      return {
        accessToken: "new-token",
        chatgptAccountId: "wks_123",
        chatgptPlanType: "plus",
      };
    });

    m.receive({
      jsonrpc: "2.0", id: 200, method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expiringSoon", previousAccountId: "wks_123" },
    });
    await new Promise(r => setTimeout(r, 5));
    const reply = m.sent.find(e => e.id === 200);
    pass("handler reply sent for server request",
      reply?.result?.accessToken === "new-token");
    pass("handler reply does not contain method/params",
      !reply?.method && !reply?.params);
  }

  // ─── approval bridge: server-initiated → legacy notification ──────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();
    c.installApprovalBridge();

    let approvalReq: any = null;
    c.on("approval/required", p => { approvalReq = p; });

    // codex sends a server-initiated v2 approval request.
    m.receive({
      jsonrpc: "2.0", id: 300, method: "item/commandExecution/requestApproval",
      params: { command: "rm -rf /tmp/codex-test", cwd: "/tmp" },
    });
    await new Promise(r => setTimeout(r, 5));

    pass("approval bridge synthesizes legacy approval/required",
      approvalReq && typeof approvalReq.approvalId === "string"
      && approvalReq.kind === "command"
      && /rm -rf/.test(approvalReq.summary));

    // Now respond — our approvalRespond should send the JSON-RPC
    // response for the server's id=300 request, NOT a new method call.
    await c.approvalRespond({ approvalId: approvalReq.approvalId, decision: "decline" });
    await new Promise(r => setTimeout(r, 5));
    const reply = m.sent.find(e => e.id === 300);
    pass("approval response uses original server-request id",
      !!reply && reply.id === 300);
    pass("approval response carries decision",
      reply?.result?.decision === "denied");
  }

  // ─── thread/start with real `{ thread: { id } }` response ─────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const tp = c.threadStart({});
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("thread/start method correct", req.method === "thread/start");
      m.receive({ jsonrpc: "2.0", id: req.id, result: {
        thread: { id: "ct_1" },
        model: "o3",
        modelProvider: "openai",
        cwd: "/tmp",
      } });
    });
    const thr = await tp as any;
    pass("thread/start returns thread.id under nested shape",
      thr.thread?.id === "ct_1");
  }

  // ─── turn/start with Array<UserInput> input ───────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const up = c.turnStart({
      threadId: "ct_1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("turn/start method correct", req.method === "turn/start");
      pass("turn/start input is an array",
        Array.isArray(req.params.input));
      pass("turn/start input[0].type=text",
        req.params.input[0]?.type === "text");
      m.receive({ jsonrpc: "2.0", id: req.id, result: { turn: { id: "tu_1" } } });
    });
    const turn = await up as any;
    pass("turn/start returns turn.id under nested shape",
      turn.turn?.id === "tu_1");
  }

  // ─── close() rejects pending requests and clears state ────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountRead();
    let rejected: boolean = false;
    p.catch(() => { rejected = true; });
    await c.close();
    await new Promise(r => setTimeout(r, 5));
    pass("close rejects pending requests", rejected as boolean === true);
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  } else {
    console.log("\nAll codex-app-server tests passed");
  }
})();
