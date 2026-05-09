// P58 — Run a chat turn through the Codex app-server bridge.
//
// Maps the bridge's notification stream onto the existing chat SSE event
// types (delta / tool_use / tool_result / done / error / approval) so the
// browser ChatView renders Codex turns identically to Anthropic turns.
//
// LIFECYCLE:
//   - Open WS to bridge
//   - Resolve or create a Codex threadId for this HyperAgent thread
//   - Subscribe to notifications
//   - Send turn/start with the user's input
//   - Forward events as SSE; resolve when turn/finished arrives
//   - Close WS on the way out
//
// APPROVAL POLICY (today):
//   This dispatcher AUTO-ACCEPTS every approval/required event. We
//   surface the approval as an SSE event so the UI shows it in the trace
//   and the user can configure their bridge's approval policy server-side
//   for stricter behavior. Interactive in-UI approvals require a
//   bidirectional control channel and ship in a follow-up phase.

import { AppServerClient } from "./app-server";
import type { CodexBridgeConfig, ApprovalRequest } from "./types";
import { getCodexThreadId, setCodexThreadId } from "./thread-map";

export interface CodexTurnDispatchOptions {
  bridge: CodexBridgeConfig;
  threadId: string;     // HyperAgent thread id
  threadTitle?: string; // used for thread/start title when we create a new Codex thread
  input: string;
  // Emitter that pushes one of our standard SSE event objects to the browser.
  send: (event: any) => void;
}

export interface CodexTurnResult {
  text: string;
  toolUses: { name: string; args: any; result?: string }[];
  approvalCount: number;
  errored: boolean;
  errorMessage?: string;
}

export async function runCodexTurn(opts: CodexTurnDispatchOptions): Promise<CodexTurnResult> {
  const client = new AppServerClient({
    url: opts.bridge.url,
    capabilityToken: opts.bridge.capabilityToken,
    capabilities: { experimentalApi: opts.bridge.experimentalApi },
  });

  let text = "";
  const toolUses: { name: string; args: any; result?: string }[] = [];
  let approvalCount = 0;
  let errored = false;
  let errorMessage: string | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  // Set a hard ceiling so the SSE stream can't hang forever if the
  // bridge swallows turn/finished. Vercel maxDuration is 300s; cap at 270.
  const turnTimeout = setTimeout(() => {
    if (!errored) {
      errored = true;
      errorMessage = "Codex turn timed out (bridge stopped emitting events)";
      opts.send({ type: "error", message: errorMessage });
    }
    resolveDone();
  }, 270_000);

  try {
    await client.connect();

    // Resolve or create the Codex-side thread.
    let codexThreadId = await getCodexThreadId(opts.threadId);
    if (!codexThreadId) {
      const r = await client.threadStart({ title: opts.threadTitle || "HyperAgent thread" });
      codexThreadId = r.threadId;
      await setCodexThreadId(opts.threadId, codexThreadId);
    }

    // Subscribe BEFORE turn/start so we never miss the first item.
    client.on("turn/itemAdded", ({ item }) => {
      if (item?.type === "text" && item.content) {
        text += item.content;
        opts.send({ type: "delta", text: item.content });
      }
    });
    client.on("turn/itemUpdated", ({ item }) => {
      // For partial text streaming, Codex may send an updated item with
      // the full content (rather than incremental delta). Detect a strict
      // prefix and only emit the delta.
      if (item?.type === "text" && typeof item.content === "string") {
        const prev = text;
        if (item.content.startsWith(prev)) {
          const delta = item.content.slice(prev.length);
          if (delta) {
            text += delta;
            opts.send({ type: "delta", text: delta });
          }
        }
      }
    });
    client.on("tool/call", ({ toolName, arguments: args, callId: _callId }) => {
      toolUses.push({ name: toolName, args });
      opts.send({ type: "tool_use", name: toolName, args });
    });
    client.on("tool/result", ({ output, callId: _callId, error }) => {
      const last = toolUses[toolUses.length - 1];
      const result = error ? `Error: ${error}` : (output || "");
      if (last) last.result = result;
      opts.send({ type: "tool_result", result });
    });
    client.on("command/executionRequested", ({ command, cwd }) => {
      // Surface as an approval-shaped event the UI can render in the trace.
      opts.send({ type: "tool_use", name: "exec", args: { command, cwd } });
    });
    client.on("file/changeRequested", ({ path, diff }) => {
      opts.send({ type: "tool_use", name: "edit_file", args: { path, diff } });
    });

    // Auto-accept approvals + emit a one-line notice for visibility.
    client.on("approval/required", async (req: ApprovalRequest) => {
      approvalCount++;
      opts.send({
        type: "approval",
        approvalId: req.approvalId,
        kind: req.kind,
        summary: req.summary,
        // Pass-through detail so the UI can show it; do NOT include any
        // bridge-internal IDs the user shouldn't see.
        detail: req.detail || req.command || req.path,
        autoAccepted: true,
      });
      try {
        await client.approvalRespond({ approvalId: req.approvalId, decision: "accept" });
      } catch (e: any) {
        opts.send({ type: "log", level: "warn", message: `approval respond failed: ${e?.message || e}` });
      }
    });

    client.on("turn/finished", () => {
      clearTimeout(turnTimeout);
      resolveDone();
    });

    client.on("log", ({ level, message }) => {
      // Forward bridge log lines to our trace channel only on warn/error;
      // info chatter is filtered out to keep the SSE stream clean.
      if (level === "warn" || level === "error") {
        opts.send({ type: "log", level, message });
      }
    });

    // Kick the turn.
    await client.turnStart({ threadId: codexThreadId, input: opts.input });

    // Wait until turn/finished or timeout fires.
    await done;
  } catch (e: any) {
    errored = true;
    errorMessage = e?.message || String(e);
    opts.send({ type: "error", message: errorMessage });
  } finally {
    clearTimeout(turnTimeout);
    await client.close().catch(() => {});
  }

  return { text, toolUses, approvalCount, errored, errorMessage };
}
