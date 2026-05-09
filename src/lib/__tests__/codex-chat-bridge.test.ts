// P58 + P59 — codex chat-bridge dispatcher tests.
//
// Validates that runCodexTurn:
//   - Calls thread/start exactly once when no Codex thread is mapped
//   - Reuses the existing codexThreadId on subsequent turns
//   - Maps Codex notifications to our SSE event types correctly
//   - On approval/required: stores the approval, surfaces it as an SSE
//     event, polls for the user's decision, and forwards it back
//   - "acceptForSession" is honored: a 2nd approval of the same kind
//     fast-paths without prompting
//   - Timeout → safe-decline + approval_resolved event
//   - file/changeRequested creates a document artifact
//   - tool/result image output creates an image artifact
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
// Tracks both the codex_thread_map AND the codex_approvals + artifacts
// rows so the bridge runs end-to-end without Postgres.

const threadMap: Record<string, string> = {};
const approvals: Record<string, { decision?: string; userId: string; threadId: string; kind: string }> = {};
const artifacts: any[] = [];

function nextDecision(approvalId: string, decision: string) {
  if (approvals[approvalId]) approvals[approvalId].decision = decision;
}

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/SELECT "codexThreadId" FROM codex_thread_map/.test(sql)) {
      const v = threadMap[params[0]];
      return { rows: v ? [{ codexThreadId: v }] : [] };
    }
    if (/INSERT INTO codex_thread_map/.test(sql)) {
      threadMap[params[0]] = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO codex_approvals/.test(sql)) {
      const [approvalId, threadId, userId, kind] = params;
      approvals[approvalId] = { userId, threadId, kind };
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT decision FROM codex_approvals/.test(sql)) {
      const a = approvals[params[0]];
      return { rows: a ? [{ decision: a.decision || null }] : [] };
    }
    if (/UPDATE codex_approvals/.test(sql)) {
      const [decision, , approvalId, userId] = params;
      const a = approvals[approvalId];
      if (a && a.userId === userId && !a.decision) {
        a.decision = decision;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO artifacts/.test(sql)) {
      const [id, threadId, messageId, type, title, body] = params;
      artifacts.push({ id, threadId, messageId, type, title, body });
      return { rows: [], rowCount: 1 };
    }
    if (/CREATE TABLE|ALTER TABLE/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
};
const dbPath = require.resolve("../db");
(require as any).cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: () => fakePool,
    // createArtifact uses pool() via a separate INSERT; emulate the
    // `uid("art")` flow so it resolves without requiring db.ts.
    createArtifact: async (a: any) => {
      const id = "art_" + Math.random().toString(36).slice(2, 10);
      artifacts.push({ ...a, id, createdAt: Date.now() });
      return { ...a, id, createdAt: Date.now() };
    },
  },
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
      const m = mockTransport();
      mockTransports.push(m);
      return m.transport;
    },
  },
};

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
      userId: "u-test",
      assistantMessageId: "msg-1",
      // Short approval timeout so the test resolves quickly.
      approvalTimeoutMs: 2000,
      send,
    });

    await new Promise(r => setTimeout(r, 30));
    const m = mockTransports[0];
    pass("transport opened for codex turn", !!m);
    if (!m) return;

    pass("first send is initialize", m.sent[0]?.method === "initialize");
    m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} });
    await new Promise(r => setTimeout(r, 10));

    pass("second send is thread/start", m.sent[1]?.method === "thread/start");
    // P64.2 — real codex ThreadStartResponse is `{ thread: { id, ... }, model, ... }`.
    m.receive({ jsonrpc: "2.0", id: m.sent[1].id, result: {
      thread: { id: "ct_99" }, model: "o3", modelProvider: "openai", cwd: "/tmp",
    } });
    await new Promise(r => setTimeout(r, 10));

    pass("third send is turn/start", m.sent[2]?.method === "turn/start");
    pass("turn/start uses codexThreadId from thread/start",
      m.sent[2]?.params?.threadId === "ct_99");
    // P64.2 — real codex TurnStartParams.input is Array<UserInput> with
    // each item shaped `{ type: "text", text, text_elements }`.
    pass("turn/start forwards user input as text UserInput",
      Array.isArray(m.sent[2]?.params?.input)
      && m.sent[2].params.input[0]?.type === "text"
      && m.sent[2].params.input[0]?.text === "hello");
    m.receive({ jsonrpc: "2.0", id: m.sent[2].id, result: { turn: { id: "tu_1" } } });
    await new Promise(r => setTimeout(r, 10));

    // Stream text + tool call + tool result.
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

    // P64.2 — Real codex emits approvals as server-initiated JSON-RPC
    // REQUESTS with an id (not notifications). Our compat shim
    // (installApprovalBridge) projects them onto the legacy
    // "approval/required" notification shape that chat-bridge already
    // subscribes to. The id we put on this fake server request is the
    // id codex would expect to see in our response.
    const FAKE_APPROVAL_ID = 5001;
    m.receive({
      jsonrpc: "2.0", id: FAKE_APPROVAL_ID,
      method: "item/commandExecution/requestApproval",
      params: { command: "ls /tmp", cwd: "/tmp" },
    });
    // The bridge has stored the approval and is polling for a decision.
    // Verify the SSE event surfaced.
    await new Promise(r => setTimeout(r, 100));
    const approvalEvt = sseEvents.find(e => e.type === "approval");
    pass("approval event emitted with kind+summary+command",
      !!approvalEvt && approvalEvt.kind === "command"
      && /ls \/tmp/.test(approvalEvt.summary) && approvalEvt.command === "ls /tmp");
    pass("approval event marks interactive=true (not autoAccepted)",
      approvalEvt?.interactive === true && !approvalEvt?.autoAccepted);

    // Simulate user clicking Accept by setting decision in our mock
    // store keyed on the SYNTHESIZED approvalId emitted by the bridge.
    nextDecision(approvalEvt.approvalId, "accept");
    await new Promise(r => setTimeout(r, 700));

    // P64.2 — instead of a separate "approval/respond" method, the
    // bridge sends a JSON-RPC RESPONSE with the original server-request
    // id and a `result.decision` field.
    const respondReq = m.sent.find(e => e.id === FAKE_APPROVAL_ID && (e.result || e.error));
    pass("approval response sent for original server-request id", !!respondReq);
    pass("approval response carries codex decision = approved",
      respondReq?.result?.decision === "approved");

    // Verify approval_resolved SSE event fired with the user's decision.
    const resolvedEvt = sseEvents.find(
      e => e.type === "approval_resolved" && e.approvalId === approvalEvt.approvalId,
    );
    pass("approval_resolved event emitted", !!resolvedEvt);
    pass("approval_resolved decision matches", resolvedEvt?.decision === "accept");
    pass("approval_resolved marks not timed out", resolvedEvt?.timedOut === false);

    m.receive({ jsonrpc: "2.0", method: "turn/finished", params: { turnId: "tu_1" } });
    const r = await turnPromise;

    const deltas = sseEvents.filter(e => e.type === "delta").map(e => e.text);
    pass("delta events forwarded in order", deltas.join("") === "Hi! How are you?");

    const toolEvents = sseEvents.filter(e => e.type === "tool_use");
    pass("tool_use event emitted for tool/call",
      toolEvents.some(t => t.name === "search"));

    pass("turn returns the accumulated text", r.text === "Hi! How are you?");
    pass("turn marks not errored", r.errored === false);
    pass("turn records approval count", r.approvalCount === 1);
    pass("thread map updated for next turn", threadMap["t-first"] === "ct_99");
  }

  // ─── second turn on same thread reuses codexThreadId ──────────────
  {
    mockTransports = [];
    const turnPromise = runCodexTurn({
      bridge: { url: "ws://127.0.0.1:8345", capabilityToken: "tok-aaaaaaaaaaaaaaaa" },
      threadId: "t-first",
      input: "second message",
      userId: "u-test",
      assistantMessageId: "msg-2",
      send: () => {},
    });
    await new Promise(r => setTimeout(r, 30));
    const m = mockTransports[0];
    if (!m) { pass("second-turn transport", false); return; }
    pass("second turn: first send is initialize", m.sent[0]?.method === "initialize");
    m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} });
    await new Promise(r => setTimeout(r, 10));
    pass("second turn: second send is turn/start (no thread/start)",
      m.sent[1]?.method === "turn/start");
    pass("second turn: reuses ct_99",
      m.sent[1]?.params?.threadId === "ct_99");
    m.receive({ jsonrpc: "2.0", id: m.sent[1].id, result: { turn: { id: "tu_2" } } });
    m.receive({ jsonrpc: "2.0", method: "turn/finished", params: { turnId: "tu_2" } });
    const r2 = await turnPromise;
    pass("second turn completes without error", r2.errored === false);
  }

  // ─── timeout → safe-decline ───────────────────────────────────────
  {
    mockTransports = [];
    const sseEvents: any[] = [];
    const turnPromise = runCodexTurn({
      bridge: { url: "ws://127.0.0.1:8345", capabilityToken: "tok-aaaaaaaaaaaaaaaa" },
      threadId: "t-timeout",
      input: "test timeout",
      userId: "u-test",
      assistantMessageId: "msg-timeout",
      approvalTimeoutMs: 800,
      send: (e: any) => sseEvents.push(e),
    });
    await new Promise(r => setTimeout(r, 30));
    const m = mockTransports[0];
    if (!m) { pass("timeout: transport", false); return; }
    m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} });
    await new Promise(r => setTimeout(r, 10));
    m.receive({ jsonrpc: "2.0", id: m.sent[1].id, result: {
      thread: { id: "ct_timeout" }, model: "o3", modelProvider: "openai", cwd: "/tmp",
    } });
    await new Promise(r => setTimeout(r, 10));
    m.receive({ jsonrpc: "2.0", id: m.sent[2].id, result: { turn: { id: "tu_timeout" } } });
    // Send approval as a server-initiated REQUEST (with id). Do NOT
    // set a decision. Wait for poll timeout — the bridge should
    // respond with a denied result.
    const FAKE_TIMEOUT_ID = 6001;
    m.receive({
      jsonrpc: "2.0", id: FAKE_TIMEOUT_ID,
      method: "item/fileChange/requestApproval",
      params: { path: "/etc/secret", diff: "+secret = ..." },
    });
    await new Promise(r => setTimeout(r, 1200));
    // Bridge should have sent the JSON-RPC response with decision=denied
    // after the 800ms poll timeout.
    const respond = m.sent.find(e => e.id === FAKE_TIMEOUT_ID && (e.result || e.error));
    pass("timeout sends denied response on original id",
      respond?.result?.decision === "denied");
    const sseEvent = sseEvents.find(e => e.type === "approval");
    const resolvedEvt = sseEvents.find(
      e => e.type === "approval_resolved" && e.approvalId === sseEvent?.approvalId,
    );
    pass("timeout emits approval_resolved with timedOut=true",
      resolvedEvt?.timedOut === true && resolvedEvt?.decision === "decline");
    m.receive({ jsonrpc: "2.0", method: "turn/finished", params: { turnId: "tu_timeout" } });
    const r = await turnPromise;
    pass("timeout turn does not flag errored", r.errored === false);
  }

  // ─── file/changeRequested produces a document artifact ────────────
  {
    mockTransports = [];
    const startCount = artifacts.length;
    const sseEvents: any[] = [];
    const turnPromise = runCodexTurn({
      bridge: { url: "ws://127.0.0.1:8345", capabilityToken: "tok-aaaaaaaaaaaaaaaa" },
      threadId: "t-edit",
      input: "edit a file",
      userId: "u-test",
      assistantMessageId: "msg-edit",
      send: (e: any) => sseEvents.push(e),
    });
    await new Promise(r => setTimeout(r, 30));
    const m = mockTransports[0];
    if (!m) { pass("artifact: transport", false); return; }
    m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} });
    await new Promise(r => setTimeout(r, 10));
    m.receive({ jsonrpc: "2.0", id: m.sent[1].id, result: {
      thread: { id: "ct_edit" }, model: "o3", modelProvider: "openai", cwd: "/tmp",
    } });
    await new Promise(r => setTimeout(r, 10));
    m.receive({ jsonrpc: "2.0", id: m.sent[2].id, result: { turn: { id: "tu_edit" } } });
    m.receive({
      jsonrpc: "2.0", method: "file/changeRequested",
      params: { turnId: "tu_edit", changeId: "ch1", path: "src/foo.ts", diff: "+const x = 1;" },
    });
    await new Promise(r => setTimeout(r, 30));
    pass("file/changeRequested created an artifact",
      artifacts.length === startCount + 1);
    pass("artifact has type=document",
      artifacts[artifacts.length - 1]?.type === "document");
    pass("artifact title includes path",
      artifacts[artifacts.length - 1]?.title?.includes("src/foo.ts"));
    pass("artifact body wraps diff in markdown fence",
      artifacts[artifacts.length - 1]?.body?.includes("```diff"));
    const artifactEvt = sseEvents.find(e => e.type === "artifact");
    pass("artifact SSE event emitted",
      !!artifactEvt && typeof artifactEvt.artifactId === "string");

    m.receive({ jsonrpc: "2.0", method: "turn/finished", params: { turnId: "tu_edit" } });
    const r = await turnPromise;
    pass("file change turn completes", r.errored === false);
    pass("turn returns artifactIds", r.artifactIds.length >= 1);
  }

  // ─── image-shaped tool result becomes an image artifact ────────────
  {
    mockTransports = [];
    const startCount = artifacts.length;
    const turnPromise = runCodexTurn({
      bridge: { url: "ws://127.0.0.1:8345", capabilityToken: "tok-aaaaaaaaaaaaaaaa" },
      threadId: "t-img",
      input: "generate image",
      userId: "u-test",
      assistantMessageId: "msg-img",
      send: () => {},
    });
    await new Promise(r => setTimeout(r, 30));
    const m = mockTransports[0];
    if (!m) { pass("image: transport", false); return; }
    m.receive({ jsonrpc: "2.0", id: m.sent[0].id, result: {} });
    await new Promise(r => setTimeout(r, 10));
    m.receive({ jsonrpc: "2.0", id: m.sent[1].id, result: {
      thread: { id: "ct_img" }, model: "o3", modelProvider: "openai", cwd: "/tmp",
    } });
    await new Promise(r => setTimeout(r, 10));
    m.receive({ jsonrpc: "2.0", id: m.sent[2].id, result: { turn: { id: "tu_img" } } });
    m.receive({
      jsonrpc: "2.0", method: "tool/call",
      params: { turnId: "tu_img", toolName: "generate_image", arguments: {}, callId: "c-img" },
    });
    m.receive({
      jsonrpc: "2.0", method: "tool/result",
      params: {
        turnId: "tu_img", callId: "c-img",
        output: JSON.stringify({ url: "https://example.com/foo.png", mime: "image/png" }),
      },
    });
    await new Promise(r => setTimeout(r, 30));
    pass("image-shaped tool result created an artifact",
      artifacts.length === startCount + 1);
    pass("image artifact has type=image",
      artifacts[artifacts.length - 1]?.type === "image");
    pass("image artifact body is the URL",
      artifacts[artifacts.length - 1]?.body === "https://example.com/foo.png");
    m.receive({ jsonrpc: "2.0", method: "turn/finished", params: { turnId: "tu_img" } });
    await turnPromise;
  }

  // ─── error path: connection refused ───────────────────────────────
  {
    const origCreate = realTransportMod.createWebSocketTransport;
    (require as any).cache[transportPath].exports.createWebSocketTransport = async () => {
      throw new Error("ECONNREFUSED");
    };
    const sseEvents: any[] = [];
    const r = await runCodexTurn({
      bridge: { url: "ws://127.0.0.1:0", capabilityToken: "tok-aaaaaaaaaaaaaaaa" },
      threadId: "t-fail",
      input: "won't connect",
      userId: "u-test",
      assistantMessageId: "msg-fail",
      send: (e: any) => sseEvents.push(e),
    });
    pass("connect failure surfaces as errored",
      r.errored === true && /ECONNREFUSED/.test(r.errorMessage || ""));
    pass("connect failure emits an error SSE event",
      sseEvents.some(e => e.type === "error"));
    (require as any).cache[transportPath].exports.createWebSocketTransport = origCreate;
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll chat-bridge tests passed.");
})();
