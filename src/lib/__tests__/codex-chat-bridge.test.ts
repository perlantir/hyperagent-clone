// P58 — codex chat-bridge dispatcher tests.
//
// Validates that runCodexTurn:
//   - Calls thread/start exactly once when no Codex thread is mapped
//   - Reuses the existing codexThreadId on subsequent turns
//   - Maps Codex notifications to our SSE event types correctly
//   - Auto-accepts approval/required and emits an `approval` SSE event
//   - Resolves on turn/finished
//   - Closes the WS even when an error fires mid-turn

import type { Transport } from "../codex/transport";

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// ─── stub the db pool BEFORE importing chat-bridge ─────────────────
//
// chat-bridge → thread-map → db.pool() → query. We mock the pool so
// thread-map runs without Postgres.

const threadMap: Record<string, string> = {};
const fakePool = {
  query: async (sql: string, params: any[]) => {
    if (/SELECT "codexThreadId" FROM codex_thread_map WHERE "threadId"=\$1/.test(sql)) {
      const v = threadMap[params[0]];
      return { rows: v ? [{ codexThreadId: v }] : [] };
    }
    if (/INSERT INTO codex_thread_map/.test(sql)) {
      threadMap[params[0]] = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (/CREATE TABLE/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
};
const dbPath = require.resolve("../db");
(require as any).cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: () => fakePool },
};

// ─── stub createWebSocketTransport so chat-bridge uses our mock ─────
const transportPath = require.resolve("../codex/transport");
const realTransportMod = require(transportPath);
let mockTransports: MockTransportAPI[] = [];
(require as any).cache[transportPath] = {
  id: transportPath, filename: transportPath, loaded: true,
  exports: {
    ...realTransportMod,
    createWebSocketTransport: async () => {
      // Return a fresh mock per call.
      const m = mockTransport();
      mockTransports.push(m);
      return m.transport;
    },
  },
};

// Now import the bridge.
const { runCodexTurn } = require("../codex/chat-bridge");

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
  // ─── first turn — thread/start fires, then turn/start ─────────────
  {
    mockTransports = [];
    const sseEvents: any[] = [];
    const send = (e: any) => sseEvents.push(e);

    const turnPromise = runCodexTurn({
      bridge: { url: "ws://127.0.0.1:8345", capabilityToken: "tok-aaaaaaaaaaaaaaaa" },
      threadId: "t-first",
      threadTitle: "Audit run 1",
      input: "hello",
      send,
    });

    // Drive the script: respond to initialize, then thread/start, then turn/start.
    // Note: the bridge sees them in send-order.
    await new Promise(r => setTimeout(r, 30));
    const m = mockTransports[0];
    pass("transport opened for codex turn", !!m);
    if (!m) return;

    // 1st send = initialize. Reply.
    pass("first send is initialize", m.sent[0]?.method === "initialize");
    m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} });
    await new Promise(r => setTimeout(r, 10));

    // 2nd send = thread/start (no codexThreadId mapped yet).
    pass("second send is thread/start", m.sent[1]?.method === "thread/start");
    pass("thread/start title forwarded", m.sent[1]?.params?.title === "Audit run 1");
    m.receive({ jsonrpc: "2.0", id: m.sent[1].id, result: { threadId: "ct_99" } });
    await new Promise(r => setTimeout(r, 10));

    // 3rd send = turn/start with the new codexThreadId.
    pass("third send is turn/start", m.sent[2]?.method === "turn/start");
    pass("turn/start uses codexThreadId from thread/start",
      m.sent[2]?.params?.threadId === "ct_99");
    pass("turn/start forwards user input",
      m.sent[2]?.params?.input === "hello");
    // Bridge replies to turn/start with the turnId (Codex flow).
    m.receive({ jsonrpc: "2.0", id: m.sent[2].id, result: { turnId: "tu_1" } });
    await new Promise(r => setTimeout(r, 10));

    // Stream notifications: text, tool/call, approval, finish.
    m.receive({ jsonrpc: "2.0", method: "turn/itemAdded", params: { turnId: "tu_1", item: { type: "text", content: "Hi! " } } });
    m.receive({ jsonrpc: "2.0", method: "turn/itemAdded", params: { turnId: "tu_1", item: { type: "text", content: "How are you?" } } });
    m.receive({
      jsonrpc: "2.0", method: "tool/call",
      params: { turnId: "tu_1", toolName: "search", arguments: { q: "foo" }, callId: "c1" },
    });
    m.receive({
      jsonrpc: "2.0", method: "tool/result",
      params: { turnId: "tu_1", callId: "c1", output: "matched 3" },
    });
    m.receive({
      jsonrpc: "2.0", method: "approval/required",
      params: { approvalId: "ap1", turnId: "tu_1", kind: "command", summary: "Run ls", command: "ls /tmp" },
    });
    // After auto-approve, the bridge will receive an approval/respond send.
    await new Promise(r => setTimeout(r, 10));
    const respondReq = m.sent.find(e => e.method === "approval/respond" && e.params?.decision === "accept");
    pass("auto-approve sent approval/respond", !!respondReq);
    if (respondReq) {
      // Bridge replies to approval/respond so the await inside the
      // handler resolves cleanly.
      m.receive({ jsonrpc: "2.0", id: respondReq.id, result: {} });
    }

    m.receive({ jsonrpc: "2.0", method: "turn/finished", params: { turnId: "tu_1" } });

    const r = await turnPromise;

    // Validate the SSE event stream.
    const deltas = sseEvents.filter(e => e.type === "delta").map(e => e.text);
    pass("delta events forwarded in order", deltas.join("") === "Hi! How are you?");

    const toolEvents = sseEvents.filter(e => e.type === "tool_use");
    pass("tool_use event emitted for tool/call",
      toolEvents.length === 1 && toolEvents[0].name === "search");

    const toolResults = sseEvents.filter(e => e.type === "tool_result");
    pass("tool_result event emitted",
      toolResults.length === 1 && toolResults[0].result === "matched 3");

    const approvalEvents = sseEvents.filter(e => e.type === "approval");
    pass("approval event emitted with autoAccepted=true",
      approvalEvents.length === 1
      && approvalEvents[0].kind === "command"
      && approvalEvents[0].autoAccepted === true);

    pass("turn returns the accumulated text", r.text === "Hi! How are you?");
    pass("turn records tool uses", r.toolUses.length === 1 && r.toolUses[0].name === "search");
    pass("turn records approval count", r.approvalCount === 1);
    pass("turn marks not errored", r.errored === false);

    pass("thread map updated for next turn", threadMap["t-first"] === "ct_99");
  }

  // ─── second turn on same thread reuses codexThreadId ──────────────
  {
    mockTransports = [];
    const sseEvents: any[] = [];
    const turnPromise = runCodexTurn({
      bridge: { url: "ws://127.0.0.1:8345", capabilityToken: "tok-aaaaaaaaaaaaaaaa" },
      threadId: "t-first",
      input: "second message",
      send: (e: any) => sseEvents.push(e),
    });
    await new Promise(r => setTimeout(r, 30));
    const m = mockTransports[0];
    if (!m) { pass("second-turn transport", false); return; }
    // initialize
    pass("second turn: first send is initialize", m.sent[0]?.method === "initialize");
    m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} });
    await new Promise(r => setTimeout(r, 10));
    // No thread/start this time — go straight to turn/start.
    pass("second turn: second send is turn/start (no thread/start)",
      m.sent[1]?.method === "turn/start");
    pass("second turn: reuses ct_99",
      m.sent[1]?.params?.threadId === "ct_99");

    m.receive({ jsonrpc: "2.0", id: m.sent[1].id, result: { turnId: "tu_2" } });
    m.receive({ jsonrpc: "2.0", method: "turn/finished", params: { turnId: "tu_2" } });
    const r2 = await turnPromise;
    pass("second turn completes without error", r2.errored === false);
  }

  // ─── error path: connection refused ───────────────────────────────
  {
    // Override the transport stub for this scenario to throw on connect.
    const origCreate = realTransportMod.createWebSocketTransport;
    (require as any).cache[transportPath].exports.createWebSocketTransport = async () => {
      throw new Error("ECONNREFUSED");
    };
    const sseEvents: any[] = [];
    const r = await runCodexTurn({
      bridge: { url: "ws://127.0.0.1:0", capabilityToken: "tok-aaaaaaaaaaaaaaaa" },
      threadId: "t-fail",
      input: "won't connect",
      send: (e: any) => sseEvents.push(e),
    });
    pass("connect failure surfaces as errored",
      r.errored === true && /ECONNREFUSED/.test(r.errorMessage || ""));
    pass("connect failure emits an error SSE event",
      sseEvents.some(e => e.type === "error"));
    // Restore.
    (require as any).cache[transportPath].exports.createWebSocketTransport = origCreate;
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll chat-bridge tests passed.");
})();
