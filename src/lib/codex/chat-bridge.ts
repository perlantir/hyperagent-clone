// P58 + P59 — Run a chat turn through the Codex app-server bridge.
//
// Maps the bridge's notification stream onto the existing chat SSE event
// types (delta / tool_use / tool_result / done / error / approval /
// artifact) so the browser ChatView renders Codex turns identically to
// Anthropic turns.
//
// LIFECYCLE:
//   - Open WS to bridge
//   - Resolve or create a Codex threadId for this HyperAgent thread
//   - Subscribe to notifications
//   - Send turn/start with the user's input
//   - Forward events as SSE; resolve when turn/finished arrives
//   - Close WS on the way out
//
// APPROVAL POLICY (P59 — interactive):
//   When the bridge sends approval/required, we surface it as an
//   `approval` SSE event AND insert a row in codex_approvals. The chat
//   lambda polls that row for the user's decision (Accept / Decline /
//   Cancel) and forwards approval/respond to the bridge over the
//   still-open WS. If the user doesn't decide within 60s, we auto-decline
//   for safety. "acceptForSession" is also remembered for the rest of
//   this turn so a long task with multiple identical commands doesn't
//   keep prompting.
//
// ARTIFACTS (P59 — bridge → canvas):
//   file/changeRequested → creates a 'document' artifact carrying the
//     unified diff so the user can review the change in the canvas.
//   tool/result with image-shaped output → creates an 'image' artifact.
//   Substantial tool/result text (>1000 chars) → creates a 'document'
//     artifact so the canvas can show it inline.

import { AppServerClient } from "./app-server";
import type { CodexBridgeConfig, ApprovalRequest } from "./types";
import { getCodexThreadId, setCodexThreadId } from "./thread-map";
import { createApproval, pollDecision, type ApprovalDecision } from "./approvals-store";
import { createArtifact } from "../db";
import { emitAuditLog } from "./audit-log";
import { randomBytes } from "node:crypto";

// P64 — connection mode for a single turn. Phase 1 = WebSocket bridge
// the user pasted; Phase 2 = locally-spawned codex app-server over
// stdio; Phase 3 = browser-direct to companion (handled client-side, the
// server never touches the WS in that flow).
export type CodexTransportMode = "bridge" | "local-stdio";

export interface CodexTurnDispatchOptions {
  // Either provide a bridge config (Phase 1) OR set transport="local-stdio"
  // (Phase 2). Phase 3 doesn't reach this server-side function — turns
  // run entirely in the browser via the companion's WS.
  bridge?: CodexBridgeConfig;
  transport?: CodexTransportMode;
  threadId: string;
  threadTitle?: string;
  input: string;
  userId: string;
  assistantMessageId: string;
  send: (event: any) => void;
  approvalTimeoutMs?: number;
  // P66b — caller can shrink the safety net for smoke tests / unit
  // tests. Default stays at 270 s for production paths so a real
  // codex turn that's just thinking hard isn't killed prematurely.
  turnTimeoutMs?: number;
}

export interface CodexTurnResult {
  text: string;
  toolUses: { name: string; args: any; result?: string }[];
  artifactIds: string[];
  approvalCount: number;
  errored: boolean;
  errorMessage?: string;
}

const APPROVAL_TIMEOUT_DEFAULT_MS = 60_000;
// File extensions we treat as "image-ish" when promoting tool results
// into the artifact canvas.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
// Heuristic threshold: tool/result text longer than this becomes a
// document artifact so the canvas pane has something to render.
const DOC_PROMOTE_MIN_LEN = 1000;

export async function runCodexTurn(opts: CodexTurnDispatchOptions): Promise<CodexTurnResult> {
  // P64 — pick the right transport. Phase 1 needs a bridge config;
  // Phase 2 doesn't (the AppServerClient builds a stdio transport
  // internally via createStdioTransport).
  const mode: CodexTransportMode = opts.transport
    || (opts.bridge ? "bridge" : "local-stdio");

  let client: AppServerClient;
  if (mode === "bridge") {
    if (!opts.bridge) {
      throw new Error("runCodexTurn(mode=bridge) requires bridge config");
    }
    // P64.2 — chat/route.ts may attach a pre-resolved IP via the
    // __preResolvedAddress / __preResolvedFamily smuggle fields after
    // it ran the DNS rebinding guard. We forward them straight to the
    // AppServerClient so the WebSocket transport pins the TCP connect
    // to the same IP. If those fields aren't set the transport falls
    // back to its own DNS lookup (which on tunnel mode means a
    // public-resolved name — already pre-validated upstream).
    const smuggled = opts.bridge as any;
    client = new AppServerClient({
      url: opts.bridge.url,
      capabilityToken: opts.bridge.capabilityToken,
      capabilities: { experimentalApi: opts.bridge.experimentalApi },
      preResolvedAddress: typeof smuggled.__preResolvedAddress === "string"
        ? smuggled.__preResolvedAddress
        : undefined,
      preResolvedFamily: smuggled.__preResolvedFamily === 6 ? 6
                       : smuggled.__preResolvedFamily === 4 ? 4
                       : undefined,
    });
  } else {
    // Phase 2 — locally-spawned stdio process. We pass a custom
    // transport built via createStdioTransport and skip the URL/token
    // bridge plumbing entirely.
    const { createStdioTransport } = await import("./transport");
    const transport = await createStdioTransport({});
    client = new AppServerClient({ transport });
  }

  // P64.2 — Real codex emits approvals as server-initiated REQUESTS,
  // not notifications. Install the legacy compat shim so the
  // .on("approval/required") subscriber below sees the same shape it
  // always did, while we transparently respond to the underlying
  // JSON-RPC request when approvalRespond fires.
  client.installApprovalBridge();

  // P66b — audit emit. We synthesize a runId locally (chat-bridge
  // doesn't take one as input today; P66d will pass it in). The id
  // is opaque and short-lived; it's only used to correlate the
  // run's lifecycle events in the audit log.
  const auditRunId = `runlocal_${randomBytes(8).toString("hex")}`;
  const auditProviderMode = mode === "bridge" ? "codexChatGPTBridge" : "codexChatGPTLocal";
  await emitAuditLog({
    userId: opts.userId,
    providerMode: auditProviderMode,
    runId: auditRunId,
    event: "run/created",
    severity: "info",
    details: { threadId: opts.threadId, transport: mode },
  });

  let text = "";
  const toolUses: { name: string; args: any; result?: string }[] = [];
  const artifactIds: string[] = [];
  let approvalCount = 0;
  let errored = false;
  let errorMessage: string | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  // P59 — kinds the user has accepted-for-session this turn.
  const sessionAccepted = new Set<string>();

  const turnTimeout = setTimeout(() => {
    if (!errored) {
      errored = true;
      errorMessage = "Codex turn timed out (bridge stopped emitting events)";
      opts.send({ type: "error", message: errorMessage });
    }
    resolveDone();
  }, opts.turnTimeoutMs ?? 270_000);

  try {
    await client.connect();

    let codexThreadId = await getCodexThreadId(opts.threadId);
    if (!codexThreadId) {
      // P64.2 — real ThreadStartResponse is `{ thread: { id, ... }, model,
      // modelProvider, cwd, ... }`. The earlier flat `{ threadId }` shape
      // never existed in codex 0.130.0. We pull thread.id and ignore the
      // other fields (forward-compat).
      const r = await client.threadStart({});
      codexThreadId = (r as any)?.thread?.id || (r as any)?.threadId;
      if (!codexThreadId) {
        throw new Error("codex thread/start did not return a thread id");
      }
      await setCodexThreadId(opts.threadId, codexThreadId);
    }

    client.on("turn/itemAdded", ({ item }) => {
      if (item?.type === "text" && item.content) {
        text += item.content;
        opts.send({ type: "delta", text: item.content });
      }
    });
    client.on("turn/itemUpdated", ({ item }) => {
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
    // P66b.1 — Real codex 0.130.0 emits v2-shaped notifications, NOT
    // the legacy `turn/itemAdded`/`turn/itemUpdated` names. Translate
    // the v2 events into the same `text` accumulator + `delta` SSE
    // shape the rest of the chat-bridge already uses. We accept BOTH
    // shapes so the existing P59 test suite (which sends legacy
    // names) keeps passing AND a real authenticated codex turn
    // produces text in ChatView.
    //
    // Wire shape per /tmp/codex-ts/v2/AgentMessageDeltaNotification.ts:
    //   { delta: string, itemId, ... }
    // Reasoning text deltas are surfaced separately at the protocol
    // level; we do NOT include them in the assistant text accumulator
    // (they're internal "thinking" state). A future enhancement could
    // route them to a separate SSE channel.
    (client as any).on("item/agentMessage/delta", (params: any) => {
      const delta = typeof params?.delta === "string" ? params.delta : "";
      if (!delta) return;
      text += delta;
      opts.send({ type: "delta", text: delta });
    });
    // P66b.1 — `item/completed` is dispatched for every item kind
    // (agent_message, tool_call, command_exec, file_change). We
    // route it differently per itemType:
    //
    //   - agent_message → final assistant text (deduped against
    //     streamed deltas so we don't double-render)
    //   - tool_call / command_exec → tool_result event for ChatView
    //     to render under the matching tool_use card
    //   - other kinds → forwarded as a log so trace remains complete
    (client as any).on("item/completed", (params: any) => {
      const itemType = params?.itemType || params?.item?.type;
      if (itemType === "agentMessage" || itemType === "agent_message") {
        const finalText = typeof params?.text === "string"
          ? params.text
          : typeof params?.item?.text === "string"
            ? params.item.text
            : "";
        if (!finalText) return;
        // If the streamed deltas already cover the final text, skip.
        if (finalText.length <= text.length) return;
        const tail = finalText.slice(text.length);
        if (tail) {
          text += tail;
          opts.send({ type: "delta", text: tail });
        }
        return;
      }
      if (itemType === "tool_call" || itemType === "command_exec" || itemType === "commandExec") {
        const last = toolUses[toolUses.length - 1];
        const output = typeof params?.output === "string"
          ? params.output
          : typeof params?.item?.output === "string"
            ? params.item.output
            : params?.item?.result ?? "";
        const error = params?.error || params?.item?.error;
        const result = error ? `Error: ${error}` : (typeof output === "string" ? output : JSON.stringify(output ?? ""));
        if (last) last.result = result;
        opts.send({ type: "tool_result", result });
      }
    });
    client.on("tool/call", ({ toolName, arguments: args }) => {
      toolUses.push({ name: toolName, args });
      opts.send({ type: "tool_use", name: toolName, args });
    });

    // P59 — promote tool results into artifacts when they look like files
    // or large bodies of text.
    client.on("tool/result", async ({ output, error }) => {
      const last = toolUses[toolUses.length - 1];
      const result = error ? `Error: ${error}` : (output || "");
      if (last) last.result = result;
      opts.send({ type: "tool_result", result });

      if (error) return;
      try {
        const artifactId = await maybePromoteResultToArtifact({
          threadId: opts.threadId,
          messageId: opts.assistantMessageId,
          toolName: last?.name,
          args: last?.args,
          output: result,
        });
        if (artifactId) {
          artifactIds.push(artifactId);
          opts.send({ type: "artifact", artifactId });
        }
      } catch (e: any) {
        opts.send({ type: "log", level: "warn", message: `artifact promote failed: ${e?.message || e}` });
      }
    });

    // P59 — file/changeRequested becomes a document artifact carrying the
    // diff. The user can review the change in the canvas without leaving
    // the chat.
    client.on("file/changeRequested", async ({ path, diff }) => {
      opts.send({ type: "tool_use", name: "edit_file", args: { path, diff } });
      try {
        const a = await createArtifact({
          threadId: opts.threadId,
          messageId: opts.assistantMessageId,
          type: "document",
          title: `Edit: ${path}`,
          body: `\`\`\`diff\n${diff || "(no diff)"}\n\`\`\``,
        });
        artifactIds.push(a.id);
        opts.send({ type: "artifact", artifactId: a.id });
      } catch (e: any) {
        opts.send({ type: "log", level: "warn", message: `edit_file artifact failed: ${e?.message || e}` });
      }
    });

    client.on("command/executionRequested", ({ command, cwd }) => {
      opts.send({ type: "tool_use", name: "exec", args: { command, cwd } });
    });

    // P59 — INTERACTIVE approvals via the DB rendezvous.
    client.on("approval/required", async (req: ApprovalRequest) => {
      approvalCount++;

      // Fast-path: if the user already accepted-for-session this kind,
      // respond immediately without a UI prompt.
      if (sessionAccepted.has(req.kind)) {
        opts.send({
          type: "approval",
          approvalId: req.approvalId,
          kind: req.kind,
          summary: req.summary,
          detail: req.detail || req.command || req.path,
          autoAccepted: true,
          sessionAccepted: true,
        });
        try { await client.approvalRespond({ approvalId: req.approvalId, decision: "accept" }); }
        catch {}
        return;
      }

      try {
        await createApproval({
          approvalId: req.approvalId,
          threadId: opts.threadId,
          userId: opts.userId,
          kind: req.kind,
          summary: req.summary,
          detail: req.detail || req.command || req.path,
        });
      } catch (e: any) {
        opts.send({ type: "log", level: "warn", message: `approval store failed: ${e?.message || e}` });
        // Fail-safe: decline rather than auto-accept on storage error.
        try { await client.approvalRespond({ approvalId: req.approvalId, decision: "decline" }); }
        catch {}
        return;
      }

      // Surface the approval card to the browser. The user clicks one of
      // the buttons; the click POSTs to /api/codex/approval/[id] which
      // updates the row.
      opts.send({
        type: "approval",
        approvalId: req.approvalId,
        kind: req.kind,
        summary: req.summary,
        detail: req.detail || req.command || req.path,
        command: req.command,
        path: req.path,
        diff: req.diff,
        // Whether the bridge is asking us to confirm the entire turn vs.
        // just one step. We don't reliably know — let the UI decide.
        interactive: true,
      });

      // Poll DB until decision arrives or we time out → safe-decline.
      const decision = await pollDecision(req.approvalId, opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_DEFAULT_MS);
      const finalDecision: ApprovalDecision =
        decision === "timeout" ? "decline" : decision;
      if (finalDecision === "acceptForSession") {
        sessionAccepted.add(req.kind);
      }

      // Tell the UI what we ended up doing.
      opts.send({
        type: "approval_resolved",
        approvalId: req.approvalId,
        decision: finalDecision,
        timedOut: decision === "timeout",
      });

      try {
        await client.approvalRespond({ approvalId: req.approvalId, decision: finalDecision });
      } catch (e: any) {
        opts.send({ type: "log", level: "warn", message: `approval respond failed: ${e?.message || e}` });
      }
    });

    client.on("turn/finished", () => {
      clearTimeout(turnTimeout);
      resolveDone();
    });

    // P66b.1 — v2 turn lifecycle. Real codex 0.130.0 emits
    // `turn/completed` (v2 ServerNotification.ts) instead of the
    // legacy `turn/finished` name. We accept both. We also map
    // `error` v2 notifications onto our error-message channel so
    // codex-side run failures surface in the chat UI.
    (client as any).on("turn/completed", (params: any) => {
      // The v2 shape carries the full Turn record including
      // tokenUsage / endedAt / status. We use the presence of the
      // notification as the signal that the run is over; the chat
      // bridge doesn't render usage today (P59 trace store does).
      void params;
      clearTimeout(turnTimeout);
      resolveDone();
    });

    // P66b.1 — v2 server-side error notifications.
    (client as any).on("error", (params: any) => {
      const msg = typeof params?.message === "string"
        ? params.message
        : typeof params?.error?.message === "string"
          ? params.error.message
          : "codex emitted an error notification";
      // We don't auto-fail the turn on every error notification —
      // codex sometimes emits warnings via this channel. We surface
      // it as a log so the user sees it without halting the run.
      opts.send({ type: "log", level: "error", message: msg });
    });

    // P66b.1 — v2 tool / command lifecycle. Codex 0.130.0 represents
    // tool calls as items (item/started + item/agentMessage/delta +
    // item/completed) where itemType reflects the kind. Map the
    // tool-shaped variants onto our existing tool_use / tool_result
    // SSE events so the ChatView UI renders them identically to the
    // legacy `tool/call` + `tool/result` path.
    (client as any).on("item/started", (params: any) => {
      const itemType = params?.itemType || params?.item?.type;
      if (itemType === "tool_call" || itemType === "command_exec" || itemType === "commandExec") {
        const name = params?.toolName || params?.item?.toolName || params?.item?.commandName || "tool";
        const input = params?.arguments ?? params?.item?.arguments ?? params?.item?.command ?? {};
        toolUses.push({ name, args: input });
        opts.send({ type: "tool_use", name, args: input });
      }
    });

    (client as any).on("item/commandExecution/outputDelta", (params: any) => {
      // Stream stdout/stderr from a v2 command_exec item back to the
      // UI as a log line. Don't accumulate into `text` — that's the
      // assistant message channel.
      const stream = params?.stream || params?.outputStream || "stdout";
      const chunk = params?.delta || params?.text || "";
      if (chunk) {
        opts.send({ type: "log", level: stream === "stderr" ? "warn" : "info", message: String(chunk).slice(0, 1000) });
      }
    });

    // P66b.1 — v2 file-change lifecycle (codex 0.130.0 ServerNotification
    // shapes: item/fileChange/patchUpdated and item/fileChange/outputDelta).
    // We promote a completed file change to the same artifact shape the
    // legacy `file/changeRequested` handler produced.
    (client as any).on("item/fileChange/patchUpdated", async (params: any) => {
      const path = params?.path || params?.filePath || params?.item?.path;
      const diff = params?.unifiedDiff || params?.patch || params?.diff;
      if (!path) return;
      opts.send({ type: "tool_use", name: "edit_file", args: { path, diff } });
      try {
        const a = await createArtifact({
          threadId: opts.threadId,
          messageId: opts.assistantMessageId,
          type: "document",
          title: `Edit: ${path}`,
          body: `\`\`\`diff\n${typeof diff === "string" ? diff : "(no diff)"}\n\`\`\``,
        });
        artifactIds.push(a.id);
        opts.send({ type: "artifact", artifactId: a.id });
      } catch (e: any) {
        opts.send({ type: "log", level: "warn", message: `edit_file artifact failed: ${e?.message || e}` });
      }
    });

    client.on("log", ({ level, message }) => {
      if (level === "warn" || level === "error") {
        opts.send({ type: "log", level, message });
      }
    });

    // P64.2 — real TurnStartParams.input is `Array<UserInput>` (each
    // element is `{ type: "text", text, text_elements }` for plain
    // text). We always wrap the inbound string into a single text item;
    // multi-modal attachments will get added in a follow-up alongside
    // the v2 attachment shapes (image / localImage / mention / skill).
    await client.turnStart({
      threadId: codexThreadId,
      input: [
        {
          type: "text",
          text: typeof opts.input === "string" ? opts.input : String(opts.input ?? ""),
          text_elements: [],
        },
      ],
    });
    await done;
  } catch (e: any) {
    errored = true;
    errorMessage = e?.message || String(e);
    opts.send({ type: "error", message: errorMessage });
  } finally {
    clearTimeout(turnTimeout);
    await client.close().catch(() => {});
  }

  // P66b — audit emit on completion. We summarise the outcome only;
  // the actual events are stored in codex_run_events via P65.1's
  // event-mirror (or in P66d's server-authoritative path).
  await emitAuditLog({
    userId: opts.userId,
    providerMode: auditProviderMode,
    runId: auditRunId,
    event: errored ? "run/failed" : "run/completed",
    severity: errored ? "error" : "info",
    details: {
      threadId: opts.threadId,
      transport: mode,
      approvalCount,
      // errorMessage is already redacted by AppServerClient before it
      // reaches us, but emitAuditLog redacts again as defense in depth.
      errorMessage: errored ? errorMessage : undefined,
      textLength: text.length,
      toolCount: toolUses.length,
      artifactCount: artifactIds.length,
    },
  });

  return { text, toolUses, artifactIds, approvalCount, errored, errorMessage };
}

// ─── helpers ─────────────────────────────────────────────────────────

interface PromoteArgs {
  threadId: string;
  messageId: string;
  toolName?: string;
  args?: any;
  output: string;
}

/**
 * Decide whether a tool result is interesting enough to show in the
 * canvas. Returns the new artifact id if we created one, else undefined.
 *
 * Heuristics:
 *   - JSON `{ url, mime }` shaped image output → image artifact
 *   - Path-shaped args + output text → document artifact (file read)
 *   - Long text (>1000 chars) → document artifact
 *   - Otherwise → no artifact (just leave it as a tool_result event)
 */
async function maybePromoteResultToArtifact(p: PromoteArgs): Promise<string | undefined> {
  const { threadId, messageId, toolName, args, output } = p;
  if (!output || output.length === 0) return undefined;

  let parsed: any;
  try { parsed = JSON.parse(output); } catch { /* leave parsed undefined */ }

  // Image-shaped output (data URL, http(s) URL with image extension, or
  // explicit { mime: "image/..." } envelope).
  if (typeof output === "string" && /^data:image\//.test(output)) {
    const a = await createArtifact({
      threadId, messageId, type: "image",
      title: toolName ? `${toolName} output` : "Image",
      body: output,
    });
    return a.id;
  }
  if (parsed && typeof parsed === "object") {
    const url = parsed.url || parsed.imageUrl || parsed.image_url;
    const mime = parsed.mime || parsed.contentType || parsed.content_type;
    if (typeof url === "string" && (IMAGE_EXT_RE.test(url) || (typeof mime === "string" && mime.startsWith("image/")))) {
      const a = await createArtifact({
        threadId, messageId, type: "image",
        title: toolName ? `${toolName} output` : "Image",
        body: url,
      });
      return a.id;
    }
  }

  // File read / write — tools that take a `path` arg and produce text body.
  const path = args && (args.path || args.filePath || args.file_path || args.file);
  if (path && typeof output === "string" && output.length > 0) {
    const a = await createArtifact({
      threadId, messageId, type: "document",
      title: `${toolName || "file"}: ${path}`,
      body: output.slice(0, 200_000),
    });
    return a.id;
  }

  // Substantial text output without a clear file context → document.
  if (typeof output === "string" && output.length >= DOC_PROMOTE_MIN_LEN) {
    const a = await createArtifact({
      threadId, messageId, type: "document",
      title: toolName ? `${toolName} output` : "Tool output",
      body: output.slice(0, 200_000),
    });
    return a.id;
  }

  return undefined;
}
