// The big one — streaming chat with tool calling, memory, multi-agent routing,
// and credit accounting.
//
// Body: { threadId: string, content: string, useRouter?: boolean,
//         attachments?: MessageAttachment[] }
// Returns: text/event-stream with JSON events (delta, tool_use, tool_result,
//   artifact, router, done, error).
//
// P31 — Multi-modal attachments. The composer attaches images / text files
// before sending. We translate them into Anthropic content blocks (image
// block for images, prefix-text for file previews) and persist the
// attachments JSON column on the user message so re-renders + replays see
// the same context.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  getThread, listMessages, createMessage, updateMessage, updateThread,
  getAgent, listAgents,
} from "@/lib/db";
import { clientForUser, DEFAULT_MODEL } from "@/lib/llm";
import { resolveAllTools, executeAnyTool, ToolCtx } from "@/lib/tools";
import { retrieveMemoriesForChat } from "@/lib/memory";
import { routeMessage } from "@/lib/router";
import { balance, chargeCredits, computeCost } from "@/lib/credits";
import { startRun, endRun, TraceEmitter } from "@/lib/traces";
import { detectLoop, truncateMessages, classifyError } from "@/lib/providers";
import { setBudgetCap, chargeRunBudget, isOverBudget, DEFAULT_CHAT_TURN_BUDGET } from "@/lib/budget";
import { isRunCancelled } from "@/lib/command-center";
import { evaluateAllApplicable } from "@/lib/rubrics";
import { recordFinding } from "@/lib/rubric-improvement";
import { getEventsForRun } from "@/lib/traces";
import { getWorkingDoc } from "@/lib/working-memory";
import { getCurrentAgentVersion } from "@/lib/agent-versions";
// Note: scheduler is now driven by Vercel Cron at /api/cron, no in-process loop.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Scheduler is now Vercel Cron at /api/cron — no in-process boot needed.

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { threadId, content, useRouter, attachments } = await req.json().catch(() => ({}));
  // Allow content-empty when an image attachment is the message — common UX
  // pattern: drop image, hit send. But still require ONE of content or attachment.
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!threadId || (!content && !hasAttachments)) {
    return NextResponse.json({ error: "threadId and (content or attachments) required" }, { status: 400 });
  }

  const thread = await getThread(threadId, user.id);
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  if (await balance(user.id) <= 0) return NextResponse.json({ error: "out of credits" }, { status: 402 });

  // Save user message — including attachments JSON so replays see the same
  // multi-modal context.
  await createMessage({
    threadId, role: "user",
    content: content || "",
    attachments: hasAttachments ? attachments : undefined,
  });
  if ((await listMessages(threadId)).filter(m => m.role === "user").length === 1) {
    // First user message → use it as title. Use the text if present, else
    // the attachment name.
    const title = content?.slice(0, 60) || (hasAttachments ? `📎 ${attachments[0].name}` : "New thread");
    await updateThread(threadId, user.id, { title });
  }

  // Smart routing: if useRouter is true and thread has no agent, pick one.
  let agentId = thread.agentId;
  let routerNote: { agentId: string; reason: string } | null = null;
  if (useRouter && !agentId) {
    const agents = (await listAgents(user.id)).filter(a => a.name.toLowerCase() !== "router");
    try {
      const decision = await routeMessage(content, agents, user.id);
      agentId = decision.agentId;
      routerNote = decision;
      await updateThread(threadId, user.id, { agentId });
    } catch (e) {
      console.error("[router]", e);
    }
  }

  const agent = agentId ? await getAgent(agentId, user.id) : null;

  // Resolve tools first so we can inject toolNames into the prompt.
  const toolNames = agent?.tools?.length ? agent.tools : ["web_search", "generate_artifact"];
  const { tools, composioToolNames, builtinTools } = await resolveAllTools(user.id, toolNames);

  // P23 — Build the layered system prompt via compiler.
  // composeSystemPrompt produces a PromptSegment[] which compilePrompt turns
  // into Anthropic system blocks with cache_control breakpoints at tier
  // boundaries. Cache hits on subsequent calls in the same thread cut the
  // system-prompt token cost dramatically.
  // P25 — three-tier memory retrieval: T1 (pinned + importance≥8 always-present)
  // and T2 (top-K cosine match against the user's current message). T3 is
  // the search_knowledge tool which the agent calls explicitly when needed.
  const { pinned: pinnedMemories, contextual: contextualMemories } =
    await retrieveMemoriesForChat(user.id, agent?.id ?? null, thread.projectId, content);
  const { composeSystemPrompt } = await import("@/lib/prompt-segments");
  const { compilePrompt } = await import("@/lib/prompt-compiler");
  const segments = composeSystemPrompt({
    agent,
    toolNames: tools.map(t => t.name),
    pinnedMemories,
    contextualMemories,
    threadContextDocId: threadId,
  });
  const compiled = compilePrompt(segments, {
    maxTokens: 16_000, // generous cap; layered prompt should fit comfortably
    emitter: ev => {
      // P28a Trace Skeleton will subscribe here once it lands. For now,
      // fingerprint + drop info just goes to the lambda log for dev visibility.
      if (ev.type === "prompt_overbudget" || ev.dropped?.length > 0) {
        console.warn("[prompt-compiler]", JSON.stringify(ev));
      }
    },
  });
  const systemBlocks = compiled.systemBlocks;

  // Build the conversation history for Anthropic.
  // P31 — translate per-message attachments into Anthropic content blocks:
  //   image attachments → { type: "image", source: { type: "base64", ... } }
  //   text-file attachments → an extra text block prefixed with the filename
  //     and the captured preview, so the model can reason about its content
  //     without us inventing a file-reading tool.
  const allMsgs = await listMessages(threadId);
  const anthropicMessages: any[] = [];
  let totalImageAttachments = 0;
  for (const m of allMsgs) {
    if (m.role === "user") {
      anthropicMessages.push({ role: "user", content: buildUserContentBlocks(m.content, m.attachments) });
      for (const a of (m.attachments || [])) if (a.kind === "image") totalImageAttachments++;
    } else if (m.role === "assistant" && m.content) {
      anthropicMessages.push({ role: "assistant", content: m.content });
    }
  }
  // Last message in DB is the user message we just stored — anthropicMessages already includes it.

  // Create the assistant message shell that we'll accumulate into.
  const assistantMsg = await createMessage({ threadId, role: "assistant", content: "" });
  const ctx: ToolCtx = { userId: user.id, threadId, messageId: assistantMsg.id, artifactsCreated: [] };

  // P28a — start a trace run. Buffered emitter; flushes once at run end.
  const runId = await startRun({
    userId: user.id,
    threadId, messageId: assistantMsg.id,
    agentId: agentId || null,
    kind: "chat_turn",
    metadata: { useRouter: !!useRouter, routerNote },
  });
  const emitter = new TraceEmitter(runId);
  // P28a hardening — attach run-wide metadata to every emitted event so trace
  // queries can filter/correlate without joining back to the run record.
  // P28b — read the latest agent version snapshot number (or 0 if the agent
  // hasn't been edited since versioning shipped). Tagged on every trace event
  // so a "replay against current state" can show a precise diff between
  // historical-version-N and current-version-M.
  const agentVersionNum = agentId ? await getCurrentAgentVersion(agentId) : 0;
  emitter.setDefaultMetadata({
    promptFingerprint: compiled.fingerprint,
    agentId: agentId || null,
    agentVersion: agentVersionNum,
    requestId: req.headers.get("x-request-id") || req.headers.get("x-vercel-id") || null,
  });

  // P27a — set the per-turn budget cap. Hard server-side limit prevents a
  // runaway agent (recursive subagents, infinite tool loops, malicious prompts)
  // from burning unlimited credits in one turn.
  const budgetCap = (agent as any)?.maxRunBudgetCredits || DEFAULT_CHAT_TURN_BUDGET;
  await setBudgetCap(runId, budgetCap);
  emitter.emit("budget_reserved", { runId, capCredits: budgetCap, scope: "chat_turn" });
  // Re-run the compiler with the real emitter attached so trace events get
  // captured. The first compile (above) was needed to get systemBlocks before
  // the assistant message existed; this second pass overwrites traced events.
  // Net cost: a few extra ms of pure-CPU compile work.
  emitter.emit("prompt_compiled", {
    fingerprint: compiled.fingerprint, totalTokens: compiled.totalTokens,
    blockCount: compiled.systemBlocks.length,
    cacheBoundaries: compiled.systemBlocks.filter(b => (b as any).cache_control).length,
    included: compiled.includedSegments, dropped: compiled.droppedSegments,
  });
  for (const d of compiled.droppedSegments) {
    emitter.emit("section_drop", { kind: d.kind, reason: d.reason });
  }
  emitter.emit("memory_read", {
    count: pinnedMemories.length + contextualMemories.length,
    pinnedCount: pinnedMemories.length,
    contextualCount: contextualMemories.length,
  });
  // P31 — log multi-modal context. Image-input tokens flow through
  // Anthropic's usage.input_tokens automatically, so no extra accounting
  // is needed; this emit is purely for trace visibility.
  if (totalImageAttachments > 0) {
    emitter.emit("memory_read", {
      count: totalImageAttachments,
      kind: "image_attachments",
      note: "image content blocks attached to user messages",
    });
  }

  const encoder = new TextEncoder();

  // Hoisted out of the try so the catch handler can reference them when
  // finalizing the trace.
  let totalIn = 0, totalOut = 0;
  let totalCacheRead = 0, totalCacheCreate = 0;

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: any) {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch {}
      }
      try {
        if (routerNote) send({ type: "router", chosenAgentId: routerNote.agentId, reason: routerNote.reason });

        let accumulatedText = "";
        const toolCallsPersisted: { name: string; args: any; result?: string; durationMs?: number }[] = [];
        const artifactIds: string[] = [];

        // Iterative tool-calling loop. Each iteration may produce text + zero or more tool_use blocks.
        let messages = anthropicMessages.slice();
        const ant = await clientForUser(user.id);

        // P29 — track per-iteration signature for loop detection.
        const iterHistory: Array<{ text: string; toolSig: string }> = [];

        for (let iter = 0; iter < 6; iter++) {
          // P32 — cooperative cancel. Operators can mark this run as
          // cancelled via Command Center; we check between iterations and
          // exit cleanly when we see the flag. The in-flight LLM stream
          // (if any) finishes the token it's emitting first.
          if (await isRunCancelled(runId)) {
            emitter.emit("error", {
              source: "command_center",
              message: "Run cancelled by operator",
              reason: "cancelled",
            });
            send({ type: "delta", text: `\n\n[Cancelled by operator.]` });
            accumulatedText += `\n\n[Cancelled by operator.]`;
            break;
          }
          // P29 — context-overflow truncation. If our messages array would
          // exceed the model's window after the system prompt, truncate the
          // middle (oldest tool_results, oldest assistant turns) before sending.
          // Conservative cap: 150k tokens leaves headroom for system + response.
          const truncated = truncateMessages(messages, 150_000);
          if (truncated.dropped > 0) {
            emitter.emit("section_drop", {
              kind: "messages_truncated",
              droppedCount: truncated.dropped,
              reason: "context overflow protection",
            });
            messages = truncated.messages;
          }

          const llmStart = Date.now();
          const stream2 = ant.messages.stream({
            model: DEFAULT_MODEL,
            max_tokens: 2048,
            system: systemBlocks as any, // Anthropic accepts string OR array-of-text-blocks-with-cache-control
            messages,
            tools: tools as any,
          });

          // Collect tool_use blocks emitted in this turn.
          const turnToolUses: { id: string; name: string; input: any }[] = [];
          let turnText = "";

          for await (const event of stream2) {
            if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
              turnToolUses.push({ id: event.content_block.id, name: event.content_block.name, input: {} });
            }
            if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                const piece = event.delta.text;
                turnText += piece;
                accumulatedText += piece;
                send({ type: "delta", text: piece });
              } else if (event.delta.type === "input_json_delta") {
                const last = turnToolUses[turnToolUses.length - 1];
                if (last) (last as any)._partial = ((last as any)._partial || "") + event.delta.partial_json;
              }
            }
          }
          const final = await stream2.finalMessage();
          const llmDuration = Date.now() - llmStart;
          totalIn += final.usage?.input_tokens || 0;
          totalOut += final.usage?.output_tokens || 0;
          const cacheRead = (final.usage as any)?.cache_read_input_tokens || 0;
          const cacheCreate = (final.usage as any)?.cache_creation_input_tokens || 0;
          totalCacheRead += cacheRead;
          totalCacheCreate += cacheCreate;
          emitter.emit("llm_call", {
            iter, model: DEFAULT_MODEL,
            inputTokens: final.usage?.input_tokens || 0,
            outputTokens: final.usage?.output_tokens || 0,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreate,
            stopReason: final.stop_reason,
          }, { durationMs: llmDuration });
          if (cacheRead > 0) emitter.emit("cache_hit", { tokens: cacheRead });
          else if (cacheCreate > 0) emitter.emit("cache_miss", { reason: "first_call_or_expired", createTokens: cacheCreate });

          // P27a — charge this iteration's cost to the run budget. We charge
          // optimistically per-iter so the loop break happens on the next
          // iter check, not after the user message has fully been processed.
          // Final charge happens at endRun via totalCostCredits.
          const iterCost = computeCost(final.usage?.input_tokens || 0, final.usage?.output_tokens || 0);
          await chargeRunBudget(runId, iterCost);
          if (await isOverBudget(runId)) {
            emitter.emit("error", {
              source: "budget_cap",
              message: `Hit per-turn budget cap (${budgetCap} credits). Stopping iteration.`,
              cap: budgetCap,
            });
            send({ type: "delta", text: `\n\n[Stopped — hit per-turn budget cap of ${budgetCap} credits.]` });
            accumulatedText += `\n\n[Stopped — hit per-turn budget cap of ${budgetCap} credits.]`;
            break;
          }

          // Resolve tool_use partials into JSON.
          for (const tu of turnToolUses) {
            try { tu.input = (tu as any)._partial ? JSON.parse((tu as any)._partial) : {}; }
            catch { tu.input = {}; }
          }

          // P29 — record signature for loop detection.
          const toolSig = turnToolUses
            .map(tu => `${tu.name}:${JSON.stringify(tu.input)}`)
            .sort().join("|");
          iterHistory.push({ text: turnText, toolSig });
          const loopCheck = detectLoop(iterHistory);
          if (loopCheck.loop) {
            emitter.emit("error", {
              source: "loop_detector",
              reason: loopCheck.reason,
              message: `Loop detected (${loopCheck.reason}). Breaking.`,
              signature: loopCheck.signature,
            });
            const reasonText =
              loopCheck.reason === "alternating" ? "alternating between two tools"
              : loopCheck.reason === "near_duplicate" ? "near-duplicate tool calls"
              : "same tool calls 3+ times with no new text";
            const stopMsg = `\n\n[Stopping — agent is looping (${reasonText}). Try rephrasing or restarting.]`;
            send({ type: "delta", text: stopMsg });
            accumulatedText += stopMsg;
            break;
          }

          // If no tool calls this turn, we're done.
          if (turnToolUses.length === 0) {
            // Keep messages history intact.
            break;
          }

          // Otherwise execute each tool and append a tool_result block, then continue the loop.
          send({ type: "delta", text: "" }); // ping

          // Append the assistant turn to the messages array (text + tool_use blocks).
          const assistantBlocks: any[] = [];
          if (turnText) assistantBlocks.push({ type: "text", text: turnText });
          for (const tu of turnToolUses) assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
          messages.push({ role: "assistant", content: assistantBlocks });

          const toolResults: any[] = [];
          for (const tu of turnToolUses) {
            send({ type: "tool_use", name: tu.name, input: tu.input, id: tu.id });
            // P28a hardening — capture the call event handle so tool_result
            // and any errors can link back via parentClientId.
            const callHandle = emitter.emit("tool_call", { name: tu.name, args: tu.input, toolUseId: tu.id });
            const t0 = Date.now();
            let result: string;
            let success = true;
            try {
              result = await executeAnyTool(tu.name, tu.input, ctx, composioToolNames, builtinTools);
            } catch (err: any) {
              result = `Tool error: ${err?.message || err}`;
              success = false;
              emitter.emit("error",
                { source: "tool", name: tu.name, message: err?.message || String(err) },
                { parentClientId: callHandle.clientId },
              );
            }
            const dt = Date.now() - t0;
            send({ type: "tool_result", id: tu.id, result, durationMs: dt });
            emitter.emit("tool_result", {
              name: tu.name, success,
              resultPreview: result.length > 500 ? result.slice(0, 500) + "…" : result,
              resultLength: result.length,
              toolUseId: tu.id,
            }, { durationMs: dt, parentClientId: callHandle.clientId });
            toolCallsPersisted.push({ name: tu.name, args: tu.input, result, durationMs: dt });
            toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
          }
          messages.push({ role: "user", content: toolResults });

          // Forward any artifacts created by tools.
          for (const a of ctx.artifactsCreated) {
            if (!artifactIds.includes(a.id)) {
              artifactIds.push(a.id);
              send({ type: "artifact", artifactId: a.id, title: a.title, artifactType: a.type });
            }
          }
        }

        // Persist the final assistant message.
        const cost = await computeCost(totalIn, totalOut);
        await updateMessage(assistantMsg.id, {
          content: accumulatedText,
          toolCalls: toolCallsPersisted,
          artifactIds,
          costCredits: cost,
        });
        await chargeCredits(user.id, cost, "Chat", assistantMsg.id);
        await updateThread(threadId, user.id, { updatedAt: Date.now() });

        send({ type: "done", messageId: assistantMsg.id, costCredits: cost, runId });
        controller.close();

        // P28a — finalize trace. Don't block the response on this; we already
        // closed the controller. Failures here are logged but never surfaced
        // to the user.
        try {
          await emitter.flush();
          // P32 — preserve operator-driven cancellation. If the run was
          // marked cancelled mid-loop, don't overwrite that with 'succeeded'.
          // We still record the partial cost so the cancelled run shows up
          // in /costs with the credits actually burned.
          const wasCancelled = await isRunCancelled(runId);
          await endRun(runId, {
            status: wasCancelled ? "cancelled" : "succeeded",
            totalInputTokens: totalIn,
            totalOutputTokens: totalOut,
            totalCacheReadTokens: totalCacheRead,
            totalCacheWriteTokens: totalCacheCreate,
            totalCostCredits: cost,
          });
        } catch (traceErr) {
          console.error("[trace finalize]", traceErr);
        }

        // P26 — auto-eval against pinned rubrics for multi-step runs.
        // Skip for trivial single-shot turns (≤2 tool calls AND no working
        // memory updates) since rubric evaluation costs an LLM call per
        // judge criterion and adds no value on chitchat.
        const wasMultiStep =
          toolCallsPersisted.length >= 2 ||
          toolCallsPersisted.some(t => t.name === "update_working_memory" || t.name === "dispatch_agent");
        if (wasMultiStep) {
          try {
            const traceEvents = await getEventsForRun(runId, user.id);
            const wd = await getWorkingDoc(threadId);
            // Build a string of system blocks for regex checks against system_prompt target
            const systemBlocksText = compiled.systemBlocks.map(b => b.text).join("\n\n");
            const tcSummary = toolCallsPersisted.map(t => ({
              name: t.name, args: t.args, result: t.result, success: !t.result?.startsWith?.("Tool error:"),
            }));
            const evalResults = await evaluateAllApplicable({
              userId: user.id,
              agentId: agentId || null,
              runId,
              userMessage: content,
              agentResponse: accumulatedText,
              systemBlocksText,
              toolCalls: tcSummary,
              traceEvents,
              workingDocSections: wd?.sections,
              run: { budgetCapCredits: budgetCap, spentCredits: cost },
              artifactIds,
            });
            // Feed each failed finding into the improvement-proposal pattern detector
            for (const r of evalResults) {
              for (const finding of r.findings) {
                if (!finding.passed) {
                  recordFinding({
                    userId: user.id, agentId: agentId || null,
                    rubricId: r.rubricId, finding,
                  }).catch(e => console.error("[rubric improvement]", e));
                }
              }
            }
          } catch (evalErr) {
            console.error("[rubric auto-eval]", evalErr);
          }
        }
      } catch (e: any) {
        console.error("[chat]", e);
        try { send({ type: "error", message: e?.message || String(e), runId }); } catch {}
        controller.close();
        try {
          emitter.emit("error", { source: "chat_route", message: e?.message || String(e) });
          await emitter.flush();
          await endRun(runId, {
            status: "failed",
            totalInputTokens: totalIn,
            totalOutputTokens: totalOut,
            errorMessage: e?.message || String(e),
          });
        } catch (traceErr) {
          console.error("[trace finalize on error]", traceErr);
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}

// P31 — Build Anthropic content blocks for a user message that may carry
// image and/or text-file attachments. Anthropic accepts a string OR an
// array of content blocks; we use the array form when attachments exist.
//
// Image translation: data URLs like `data:image/png;base64,...` are split
// into { media_type, data } parts that Anthropic's vision model expects.
// File previews become an extra text block so the model sees the file
// name + first ~8 KB inline. We keep them as separate blocks so the
// preview is visually distinct from the user's question.
function buildUserContentBlocks(text: string, attachments?: any[]): any {
  if (!attachments || attachments.length === 0) return text || "";
  const blocks: any[] = [];
  for (const a of attachments) {
    if (a.kind === "image" && typeof a.dataUrl === "string") {
      const m = a.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: m[1], data: m[2] },
        });
      }
    } else if (a.kind === "file" && typeof a.textPreview === "string") {
      blocks.push({
        type: "text",
        text: `[Attached file: ${a.name} (${a.contentType}, ${a.size} bytes)]\n\n${a.textPreview}${a.textPreview.length >= 8000 ? "\n\n[…truncated, showing first 8 KB]" : ""}`,
      });
    }
  }
  if (text) blocks.push({ type: "text", text });
  // Anthropic requires non-empty content. If somehow nothing translated,
  // fall back to the raw text (or a placeholder) so the call doesn't 400.
  return blocks.length > 0 ? blocks : (text || "(empty message)");
}
