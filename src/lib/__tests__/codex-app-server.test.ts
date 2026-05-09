// P57 — codex AppServerClient JSON-RPC tests with a mock transport.
//
// Validates:
//   - initialize handshake fires before any other request
//   - account/read, account/login/start, account/logout, account/rateLimits/read
//     produce the right method strings and params
//   - request/response correlation by id
//   - notification fan-out to subscribers (turn events, approvals, log)
//   - approval/respond round-trip
//   - close() rejects pending promises and cleans up
//   - chatgptAuthTokens flow gated by capabilities.experimentalApi
//   - traces never see raw tokens / callback URLs (redaction integration)

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
    // Auto-respond to initialize with a result.
    queueMicrotask(() => {
      // The first send is initialize.
      const init = m.sent[0];
      pass("initialize sent first", init?.method === "initialize");
      pass("initialize has client info", init?.params?.clientInfo?.name === "hyperagent-clone");
      pass("initialize defaults experimentalApi=false",
        init?.params?.capabilities?.experimentalApi === false);
      m.receive({ jsonrpc: "2.0", id: init.id, result: { serverInfo: { name: "codex-app-server" } } });
    });
    await c.connect();
    pass("connect resolves after initialize", true);

    // Trace records both send + recv envelopes.
    pass("trace captures initialize send",
      traceLog.some(e => e.kind === "send" && e.envelope?.method === "initialize"));
    pass("trace captures initialize response",
      traceLog.some(e => e.kind === "recv" && e.envelope?.id === m.sent[0].id));
  }

  // ─── account/read ──────────────────────────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    // Auto-respond initialize.
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountRead();
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("account/read method correct", req.method === "account/read");
      m.receive({ jsonrpc: "2.0", id: req.id, result: { authMode: "chatgpt", email: "u@example.com", plan: "plus" } });
    });
    const r = await p;
    pass("account/read returns parsed result", r.email === "u@example.com" && r.plan === "plus");
  }

  // ─── account/login/start ───────────────────────────────────────────
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
      m.receive({ jsonrpc: "2.0", id: req.id, result: { loginUrl: "https://auth.openai.com/login?code=abc" } });
    });
    const r = await p;
    pass("login/start returns loginUrl", typeof r.loginUrl === "string");
  }

  // ─── login/start with apiKey ───────────────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountLoginStart({ type: "apiKey", apiKey: "sk-test-1234567890" });
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("login/start apiKey type correct", req.params.type === "apiKey");
      m.receive({ jsonrpc: "2.0", id: req.id, result: {} });
    });
    await p;
    pass("login/start apiKey resolves", true);
  }

  // ─── login/start with device code ──────────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountLoginStart({ type: "chatgptDeviceCode" });
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("login/start chatgptDeviceCode type correct", req.params.type === "chatgptDeviceCode");
      m.receive({ jsonrpc: "2.0", id: req.id, result: { userCode: "ABCD-1234", verificationUri: "https://auth.openai.com/device" } });
    });
    const r = await p;
    pass("device-code result has userCode", r.userCode === "ABCD-1234");
  }

  // ─── account/logout ────────────────────────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountLogout();
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("account/logout method correct", req.method === "account/logout");
      m.receive({ jsonrpc: "2.0", id: req.id, result: {} });
    });
    await p;
    pass("account/logout resolves", true);
  }

  // ─── account/rateLimits/read ───────────────────────────────────────
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

  // ─── notifications fan-out ─────────────────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    let approvalReq: any = null;
    let logCount = 0;
    c.on("approval/required", p => { approvalReq = p; });
    c.on("log", () => { logCount++; });
    c.on("turn/finished", () => { /* coverage */ });

    m.receive({ jsonrpc: "2.0", method: "log", params: { level: "info", message: "hello" } });
    m.receive({ jsonrpc: "2.0", method: "log", params: { level: "warn", message: "test" } });
    m.receive({
      jsonrpc: "2.0", method: "approval/required",
      params: { approvalId: "a1", turnId: "t1", kind: "command", summary: "Run ls", command: "ls" },
    });
    pass("log notification fired twice", logCount === 2);
    pass("approval/required notification routed",
      approvalReq?.approvalId === "a1" && approvalReq?.kind === "command");
  }

  // ─── approval/respond round-trip ───────────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.approvalRespond({ approvalId: "a1", decision: "accept" });
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("approval/respond method correct", req.method === "approval/respond");
      pass("approval/respond decision passed",
        req.params.approvalId === "a1" && req.params.decision === "accept");
      m.receive({ jsonrpc: "2.0", id: req.id, result: {} });
    });
    await p;
    pass("approval/respond resolves", true);
  }

  // ─── thread/start + turn/start ─────────────────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const tp = c.threadStart({ title: "Audit run" });
    queueMicrotask(() => {
      const req = m.sent[1];
      pass("thread/start method correct", req.method === "thread/start");
      m.receive({ jsonrpc: "2.0", id: req.id, result: { threadId: "ct_1" } });
    });
    const thr = await tp;
    pass("thread/start returns threadId", thr.threadId === "ct_1");

    const up = c.turnStart({ threadId: "ct_1", input: "hello" });
    queueMicrotask(() => {
      const req = m.sent[2];
      pass("turn/start method correct", req.method === "turn/start");
      pass("turn/start params correct",
        req.params.threadId === "ct_1" && req.params.input === "hello");
      m.receive({ jsonrpc: "2.0", id: req.id, result: { turnId: "tu_1" } });
    });
    const turn = await up;
    pass("turn/start returns turnId", turn.turnId === "tu_1");
  }

  // ─── chatgptAuthTokens flow gated by experimentalApi ───────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport, capabilities: { experimentalApi: false } });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    let threw = false;
    try { await c.accountChatgptAuthTokensRefresh(); } catch (e: any) {
      threw = /experimentalApi/.test(e.message);
    }
    pass("chatgptAuthTokens/refresh blocked without experimentalApi", threw);
  }

  // ─── close() rejects pending requests and clears state ─────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountRead();
    // Don't respond — instead close.
    let rejectedWith: any = null;
    p.catch(e => { rejectedWith = e; });
    await c.close();
    // Yield once for promise propagation.
    await new Promise(r => setTimeout(r, 10));
    pass("close() rejects pending request",
      rejectedWith && /closed/i.test(rejectedWith.message));
  }

  // ─── transport-close also rejects pending ──────────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountRead();
    let rejectedWith: any = null;
    p.catch(e => { rejectedWith = e; });
    m.triggerClose();
    await new Promise(r => setTimeout(r, 10));
    pass("transport close rejects pending",
      rejectedWith && /closed/i.test(rejectedWith.message));
  }

  // ─── trace redaction integration ───────────────────────────────────
  {
    const m = mockTransport();
    const traceLog: any[] = [];
    const c = new AppServerClient({ transport: m.transport, onTrace: e => traceLog.push(e) });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    // Sneaky login response that includes a callback URL.
    const p = c.accountLoginStart({ type: "chatgpt" });
    queueMicrotask(() => {
      const req = m.sent[1];
      m.receive({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          loginUrl: "https://auth.openai.com/login?code=abc&state=xyz",
          accessToken: "real-secret-token-xyz123",
        },
      });
    });
    await p;

    // The trace MUST be redacted. Search the trace log for raw secrets.
    const dump = JSON.stringify(traceLog);
    pass("trace never contains raw accessToken value",
      !dump.includes("real-secret-token-xyz123"));
    pass("trace never contains raw callback URL",
      !dump.includes("auth.openai.com/login?code=abc"));
    pass("trace redacts the accessToken field",
      dump.includes("[REDACTED:accessToken]"));
  }

  // ─── error responses surface a redacted message ────────────────────
  {
    const m = mockTransport();
    const c = new AppServerClient({ transport: m.transport });
    queueMicrotask(() => m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} }));
    await c.connect();

    const p = c.accountRead();
    queueMicrotask(() => {
      const req = m.sent[1];
      m.receive({
        jsonrpc: "2.0", id: req.id,
        error: {
          code: -32603,
          message: "Auth failed for token sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
          data: { Authorization: "Bearer abc.def.ghi" },
        },
      });
    });

    let caught: any = null;
    try { await p; } catch (e) { caught = e; }
    pass("error response rejects",
      caught instanceof Error && /failed/.test(caught.message));
    pass("error message redacted before throw",
      caught && !caught.message.includes("sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"));
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll AppServerClient tests passed.");
})();
