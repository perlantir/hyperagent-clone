// P66b.1 — Chat-bridge v2 notification name compatibility tests.
//
// Real codex 0.130.0 emits v2-shaped notifications:
//   - item/agentMessage/delta              (assistant text streaming)
//   - item/completed (itemType: agent_message)  (final assistant text)
//   - turn/completed                       (run done)
//   - error                                (server-side error)
//   - item/started (itemType: tool_call)   (tool invocation)
//   - item/commandExecution/outputDelta    (tool stdout/stderr stream)
//   - item/completed (itemType: tool_call) (tool result)
//   - item/fileChange/patchUpdated         (file edit)
//
// Earlier P64/P59 chat-bridge.ts subscribed to legacy names
// (`turn/itemAdded`, `turn/finished`, `tool/call`, `tool/result`,
// `file/changeRequested`). P66b.1 adds the v2 handlers so a real
// authenticated codex turn produces text in ChatView.
//
// This file proves BOTH shapes work — legacy continues to function
// AND v2 is consumed correctly. Tests use the same mock-transport
// scaffolding as `codex-chat-bridge.test.ts`.

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// ─── DB / approvals / thread-map mocks ────────────────────────────────

const auditEvents: any[] = [];
const artifacts: any[] = [];
const threadMap: Record<string, string> = {};

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO codex_audit_log/.test(sql)) {
      auditEvents.push({
        userId: params[0], event: params[5], severity: params[6],
        details: params[7] && typeof params[7] === "string" ? JSON.parse(params[7]) : params[7],
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};
const dbPath = require.resolve("../db");
(require as any).cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: () => fakePool,
    createArtifact: async (a: any) => {
      const stub = { id: `art_${artifacts.length + 1}`, ...a };
      artifacts.push(stub);
      return stub;
    },
  },
};

const threadMapPath = require.resolve("../codex/thread-map");
(require as any).cache[threadMapPath] = {
  id: threadMapPath, filename: threadMapPath, loaded: true,
  exports: {
    getCodexThreadId: async (t: string) => threadMap[t] || null,
    setCodexThreadId: async (t: string, ct: string) => { threadMap[t] = ct; },
  },
};

const approvalsPath = require.resolve("../codex/approvals-store");
(require as any).cache[approvalsPath] = {
  id: approvalsPath, filename: approvalsPath, loaded: true,
  exports: {
    createApproval: async () => undefined,
    pollDecision: async () => "decline",
  },
};

// Mock the transport module — we drive it manually so the test
// process never spawns a real codex. We use bridge mode here (not
// local-stdio) because static imports of createWebSocketTransport
// are intercepted via require.cache; the local-stdio path uses a
// dynamic import that bypasses our cache trick.
let mockTransports: any[] = [];
const transportPath = require.resolve("../codex/transport");
const realTransport = require("../codex/transport");
(require as any).cache[transportPath] = {
  id: transportPath, filename: transportPath, loaded: true,
  exports: {
    ...realTransport,
    createWebSocketTransport: async () => {
      const m = mockTransport();
      mockTransports.push(m);
      return m.transport;
    },
  },
};

const { runCodexTurn } = require("../codex/chat-bridge");

interface MockAPI {
  transport: any;
  sent: any[];
  receive: (env: any) => void;
}
function mockTransport(): MockAPI {
  const sent: any[] = [];
  let onMsg: ((env: any) => void) | null = null;
  return {
    sent,
    transport: {
      send: async (env: any) => { sent.push(env); },
      onMessage: (h: any) => { onMsg = h; },
      onClose: () => undefined,
      close: async () => undefined,
    },
    receive: (env: any) => onMsg?.(env),
  };
}

// ─── Drives ──────────────────────────────────────────────────────

async function runWithEvents(emit: (m: MockAPI) => Promise<void> | void): Promise<{ result: any; sseEvents: any[] }> {
  mockTransports = [];
  const sseEvents: any[] = [];
  const send = (e: any) => sseEvents.push(e);
  // Use bridge mode for the test scaffolding (the v2 dispatch is
  // identical in both modes; what matters is the client's
  // notification handlers, not which transport carries them).
  const turn = runCodexTurn({
    transport: "bridge",
    bridge: {
      url: "ws://127.0.0.1:8345",
      capabilityToken: "tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      experimentalApi: false,
    },
    threadId: `t_${Math.random().toString(16).slice(2, 8)}`,
    threadTitle: "v2 test",
    input: "smoke",
    userId: `u_${Math.random().toString(16).slice(2, 8)}`,
    assistantMessageId: "msg_v2",
    send,
    approvalTimeoutMs: 500,
    turnTimeoutMs: 6_000,
  });
  // Wait for the chat-bridge to register its message handler.
  await new Promise(r => setTimeout(r, 30));
  const m = mockTransports[0];
  if (!m) throw new Error("no mock transport");

  // initialize handshake.
  m.receive({
    jsonrpc: "2.0", id: m.sent[0].id,
    result: { userAgent: "fake/0.0", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" },
  });
  await new Promise(r => setTimeout(r, 5));
  // thread/start response.
  m.receive({
    jsonrpc: "2.0", id: m.sent[1].id,
    result: { thread: { id: "ct_v2" }, model: "gpt-5", modelProvider: "openai", cwd: "/tmp" },
  });
  await new Promise(r => setTimeout(r, 5));
  // turn/start response.
  m.receive({
    jsonrpc: "2.0", id: m.sent[2].id,
    result: { turn: { id: "tu_v2" } },
  });
  await new Promise(r => setTimeout(r, 5));

  await emit(m);
  await new Promise(r => setTimeout(r, 30));

  const result = await turn;
  return { result, sseEvents };
}

(async () => {
  // ─── v2 happy path: agent message delta + turn/completed ──────────
  {
    const { result, sseEvents } = await runWithEvents(async (m) => {
      m.receive({
        jsonrpc: "2.0", method: "turn/started",
        params: { turnId: "tu_v2" },
      });
      m.receive({
        jsonrpc: "2.0", method: "item/agentMessage/delta",
        params: { itemId: "im1", delta: "Hel" },
      });
      m.receive({
        jsonrpc: "2.0", method: "item/agentMessage/delta",
        params: { itemId: "im1", delta: "lo," },
      });
      m.receive({
        jsonrpc: "2.0", method: "item/agentMessage/delta",
        params: { itemId: "im1", delta: " world" },
      });
      m.receive({
        jsonrpc: "2.0", method: "item/completed",
        params: { itemId: "im1", itemType: "agent_message", text: "Hello, world" },
      });
      m.receive({
        jsonrpc: "2.0", method: "turn/completed",
        params: { turnId: "tu_v2", status: { type: "completed" } },
      });
    });
    pass("v2: turn completed without error", result.errored === false);
    pass("v2: assistant text accumulated from deltas",
      result.text === "Hello, world");
    const deltas = sseEvents.filter((e) => e.type === "delta").map((e) => e.text);
    pass("v2: 3 delta SSE events fired in order",
      deltas.join("") === "Hello, world" && deltas.length === 3);
    pass("v2: item/completed dedupes against streamed deltas (no extra delta)",
      deltas.length === 3 && !deltas.includes("Hello, world"));
  }

  // ─── v2 sequence where item/completed delivers text NOT covered by deltas ─
  // Tests the "final-text fills the tail" path.
  {
    const { result, sseEvents } = await runWithEvents(async (m) => {
      m.receive({
        jsonrpc: "2.0", method: "item/agentMessage/delta",
        params: { itemId: "im1", delta: "OK" },
      });
      // item/completed with longer text than the delta accumulator.
      m.receive({
        jsonrpc: "2.0", method: "item/completed",
        params: { itemId: "im1", itemType: "agent_message", text: "OK!" },
      });
      m.receive({
        jsonrpc: "2.0", method: "turn/completed",
        params: { turnId: "tu_v2" },
      });
    });
    pass("v2: tail of item/completed appended", result.text === "OK!");
    const deltas = sseEvents.filter((e) => e.type === "delta").map((e) => e.text);
    pass("v2: tail produced its own delta SSE event",
      deltas.length === 2 && deltas[0] === "OK" && deltas[1] === "!");
  }

  // ─── legacy P64 path still works ─────────────────────────────────
  {
    const { result, sseEvents } = await runWithEvents(async (m) => {
      m.receive({
        jsonrpc: "2.0", method: "turn/itemAdded",
        params: { turnId: "tu_v2", item: { type: "text", content: "Hi " } },
      });
      m.receive({
        jsonrpc: "2.0", method: "turn/itemAdded",
        params: { turnId: "tu_v2", item: { type: "text", content: "there" } },
      });
      m.receive({
        jsonrpc: "2.0", method: "turn/finished",
        params: { turnId: "tu_v2" },
      });
    });
    pass("legacy: turn completed",
      result.errored === false && result.text === "Hi there");
    const deltas = sseEvents.filter((e) => e.type === "delta").map((e) => e.text);
    pass("legacy: deltas joined in order",
      deltas.join("") === "Hi there" && deltas.length === 2);
  }

  // ─── mixed v2 + legacy (defense in depth) ───────────────────────
  {
    const { result } = await runWithEvents(async (m) => {
      m.receive({
        jsonrpc: "2.0", method: "turn/itemAdded",
        params: { turnId: "tu_v2", item: { type: "text", content: "First " } },
      });
      m.receive({
        jsonrpc: "2.0", method: "item/agentMessage/delta",
        params: { itemId: "im1", delta: "second" },
      });
      m.receive({
        jsonrpc: "2.0", method: "turn/completed",
        params: { turnId: "tu_v2" },
      });
    });
    pass("mixed shapes: both contribute to final text",
      result.text === "First second");
  }

  // ─── v2 tool_call lifecycle ─────────────────────────────────────
  {
    const { result, sseEvents } = await runWithEvents(async (m) => {
      m.receive({
        jsonrpc: "2.0", method: "item/started",
        params: { itemId: "im2", itemType: "tool_call", toolName: "search", arguments: { q: "foo" } },
      });
      m.receive({
        jsonrpc: "2.0", method: "item/completed",
        params: { itemId: "im2", itemType: "tool_call", output: "result-text" },
      });
      m.receive({
        jsonrpc: "2.0", method: "turn/completed",
        params: { turnId: "tu_v2" },
      });
    });
    const toolUses = sseEvents.filter((e) => e.type === "tool_use");
    const toolResults = sseEvents.filter((e) => e.type === "tool_result");
    pass("v2 tool_call: tool_use SSE event fired",
      toolUses.length === 1 && toolUses[0].name === "search");
    pass("v2 tool_call: tool_result SSE event fired",
      toolResults.length === 1 && toolResults[0].result === "result-text");
    pass("v2 tool_call: result captured on toolUses entry",
      result.toolUses.length === 1 && result.toolUses[0].result === "result-text");
  }

  // ─── v2 file-change lifecycle promotes to artifact ───────────────
  {
    const before = artifacts.length;
    const { result, sseEvents } = await runWithEvents(async (m) => {
      m.receive({
        jsonrpc: "2.0", method: "item/fileChange/patchUpdated",
        params: { path: "src/foo.ts", unifiedDiff: "+const x = 1;" },
      });
      m.receive({
        jsonrpc: "2.0", method: "turn/completed",
        params: { turnId: "tu_v2" },
      });
    });
    pass("v2 file change: artifact created",
      artifacts.length === before + 1
      && artifacts[artifacts.length - 1].title?.includes("src/foo.ts"));
    const artifactEvt = sseEvents.find((e) => e.type === "artifact");
    pass("v2 file change: artifact SSE event emitted",
      !!artifactEvt && typeof artifactEvt.artifactId === "string");
    pass("v2 file change: artifactIds returned by run",
      result.artifactIds.length >= 1);
  }

  // ─── v2 error notification → log SSE event ──────────────────────
  {
    const { result, sseEvents } = await runWithEvents(async (m) => {
      m.receive({
        jsonrpc: "2.0", method: "error",
        params: { message: "model temporarily unavailable" },
      });
      m.receive({
        jsonrpc: "2.0", method: "item/agentMessage/delta",
        params: { itemId: "im1", delta: "fallback" },
      });
      m.receive({
        jsonrpc: "2.0", method: "turn/completed",
        params: { turnId: "tu_v2" },
      });
    });
    pass("v2 error notification: turn still completes",
      result.errored === false);
    const errLog = sseEvents.find((e) => e.type === "log" && e.level === "error");
    pass("v2 error notification: surfaced as log SSE",
      !!errLog && /unavailable/.test(errLog.message));
  }

  // ─── v2 commandExecution outputDelta forwarded as log ───────────
  {
    const { sseEvents } = await runWithEvents(async (m) => {
      m.receive({
        jsonrpc: "2.0", method: "item/started",
        params: { itemId: "im3", itemType: "command_exec", item: { command: "ls" } },
      });
      m.receive({
        jsonrpc: "2.0", method: "item/commandExecution/outputDelta",
        params: { stream: "stdout", delta: "file1\nfile2\n" },
      });
      m.receive({
        jsonrpc: "2.0", method: "item/commandExecution/outputDelta",
        params: { stream: "stderr", delta: "warning: foo\n" },
      });
      m.receive({
        jsonrpc: "2.0", method: "item/completed",
        params: { itemId: "im3", itemType: "command_exec", output: "exit 0" },
      });
      m.receive({
        jsonrpc: "2.0", method: "turn/completed",
        params: { turnId: "tu_v2" },
      });
    });
    const stdoutLog = sseEvents.find((e) => e.type === "log" && e.level === "info" && /file1/.test(e.message));
    const stderrLog = sseEvents.find((e) => e.type === "log" && e.level === "warn" && /warning/.test(e.message));
    pass("v2 commandExec stdout → info log",
      !!stdoutLog);
    pass("v2 commandExec stderr → warn log",
      !!stderrLog);
  }

  // ─── audit emit ran for every v2 success path ───────────────────
  {
    const created = auditEvents.filter((a) => a.event === "run/created").length;
    const completed = auditEvents.filter((a) => a.event === "run/completed").length;
    pass("audit: each test run emitted run/created",
      created >= 7);
    pass("audit: each successful run emitted run/completed",
      completed >= 6);
  }

  if (failed > 0) {
    console.error(`\n${failed} chat-bridge-v2 test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-chat-bridge-v2 tests passed");
})().catch((e) => {
  console.error("[v2 test] fatal:", e);
  process.exit(1);
});
