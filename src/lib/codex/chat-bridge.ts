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

export interface CodexTurnDispatchOptions {
  bridge: CodexBridgeConfig;
  threadId: string;       // HyperAgent thread id
  threadTitle?: string;   // used for thread/start when we create a new Codex thread
  input: string;
  userId: string;         // user that owns the thread (approvals are scoped to this id)
  // The assistant message row this turn writes into. Artifacts produced
  // from bridge events are linked to this messageId so the chat view
  // attaches them under the right turn.
  assistantMessageId: string;
  send: (event: any) => void;
  // P59 — soft cap on waiting for a user decision per approval.
  // After this elapses we auto-decline. Defaults to 60s.
  approvalTimeoutMs?: number;
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
  const client = new AppServerClient({
    url: opts.bridge.url,
    capabilityToken: opts.bridge.capabilityToken,
    capabilities: { experimentalApi: opts.bridge.experimentalApi },
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
  }, 270_000);

  try {
    await client.connect();

    let codexThreadId = await getCodexThreadId(opts.threadId);
    if (!codexThreadId) {
      const r = await client.threadStart({ title: opts.threadTitle || "HyperAgent thread" });
      codexThreadId = r.threadId;
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

    client.on("log", ({ level, message }) => {
      if (level === "warn" || level === "error") {
        opts.send({ type: "log", level, message });
      }
    });

    await client.turnStart({ threadId: codexThreadId, input: opts.input });
    await done;
  } catch (e: any) {
    errored = true;
    errorMessage = e?.message || String(e);
    opts.send({ type: "error", message: errorMessage });
  } finally {
    clearTimeout(turnTimeout);
    await client.close().catch(() => {});
  }

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
