// P24 — Non-streaming reusable agent loop.
//
// Used by subagents (dispatch_agent) and any future surface that needs to
// run an agent turn without SSE streaming. The streaming chat route stays
// distinct in chat/route.ts because it has its own SSE wire format and
// per-event UI hooks.
//
// What this provides:
//   - One agent turn with a tool-calling loop (max 6 iterations)
//   - Retry on transient errors via withRetry
//   - Budget cap enforcement (breaks loop if exceeded)
//   - Loop detection (alternating / identical / near-duplicate)
//   - Context-overflow truncation
//   - Trace events emitted per-iter (prompt_compiled, llm_call, tool_call, tool_result, retry, cache_hit/miss, error)
//   - Structured result with summary + artifacts + cost + trace ref
//
// What it does NOT do:
//   - Stream output to a caller (use chat/route.ts for that)
//   - Manage thread persistence — caller decides how to record messages
//   - Manage user-level credit ledger — caller calls chargeCredits

import { clientForUser, DEFAULT_MODEL } from "./llm";
import { resolveAllTools, executeAnyTool, type ToolCtx } from "./tools";
import { computeCost } from "./credits";
import { TraceEmitter } from "./traces";
import { withRetry, detectLoop, truncateMessages } from "./providers";
import { isOverBudget, chargeRunBudget } from "./budget";

export interface AgentRunInput {
  userId: string;
  threadId: string;
  messageId: string;
  runId: string;            // already created by caller; we attach traces to it
  emitter: TraceEmitter;
  systemBlocks: any[];      // pre-compiled by caller via prompt-compiler
  messages: any[];          // initial conversation history
  tools: any[];             // tool defs the subagent may use
  composioToolNames: Set<string>;
  builtinTools: any[];
  budgetCap: number;        // hard cap; loop breaks if exceeded
  depth: number;            // 0 for chat, 1+ for subagents
  maxIterations?: number;   // default 6
  deadlineMs?: number;      // default 120000
}

export interface AgentRunResult {
  finalText: string;
  toolCalls: Array<{ name: string; args: any; result?: string; durationMs?: number }>;
  artifactsCreated: Array<{ id: string; type: string; title: string }>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  costCredits: number;
  iterations: number;
  status: "succeeded" | "failed" | "timeout" | "loop_detected" | "budget_exhausted";
  errorMessage?: string;
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const maxIter = input.maxIterations ?? 6;
  const deadline = startedAt + (input.deadlineMs ?? 120_000);

  const ctx: ToolCtx = {
    userId: input.userId,
    threadId: input.threadId,
    messageId: input.messageId,
    artifactsCreated: [],
  };
  // Stash run + depth on ctx so dispatch_agent can pick them up for nesting
  (ctx as any).runId = input.runId;
  (ctx as any).depth = input.depth;

  const toolCalls: Array<{ name: string; args: any; result?: string; durationMs?: number }> = [];
  let messages = input.messages.slice();
  let finalText = "";
  let totalIn = 0, totalOut = 0;
  let totalCacheRead = 0, totalCacheCreate = 0;
  const iterHistory: Array<{ text: string; toolSig: string }> = [];

  let status: AgentRunResult["status"] = "succeeded";
  let errorMessage: string | undefined;
  let iter = 0;

  try {
    const ant = await clientForUser(input.userId);

    for (iter = 0; iter < maxIter; iter++) {
      // Deadline check
      if (Date.now() > deadline) {
        status = "timeout";
        errorMessage = `Subagent exceeded deadline (${input.deadlineMs ?? 120_000}ms)`;
        input.emitter.emit("error", { source: "agent_runner", reason: "deadline", iter });
        break;
      }

      // Context-overflow protection
      const truncated = truncateMessages(messages, 150_000);
      if (truncated.dropped > 0) {
        input.emitter.emit("section_drop", {
          kind: "messages_truncated",
          droppedCount: truncated.dropped,
          summary: truncated.summary,
        });
        messages = truncated.messages;
      }

      const llmStart = Date.now();
      const result = await withRetry(
        () => ant.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: 2048,
          system: input.systemBlocks as any,
          messages,
          tools: input.tools as any,
        }),
        {
          maxAttempts: 3,
          onRetry: (attempt, classified, delayMs) =>
            input.emitter.emit("retry", { attempt, errorClass: classified.class, reason: classified.reason, delayMs, iter }),
        },
      );
      const llmDuration = Date.now() - llmStart;

      totalIn += result.usage?.input_tokens || 0;
      totalOut += result.usage?.output_tokens || 0;
      const cacheRead = (result.usage as any)?.cache_read_input_tokens || 0;
      const cacheCreate = (result.usage as any)?.cache_creation_input_tokens || 0;
      totalCacheRead += cacheRead;
      totalCacheCreate += cacheCreate;

      input.emitter.emit("llm_call", {
        iter, model: DEFAULT_MODEL,
        inputTokens: result.usage?.input_tokens || 0,
        outputTokens: result.usage?.output_tokens || 0,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreate,
        stopReason: result.stop_reason,
      }, { durationMs: llmDuration });
      if (cacheRead > 0) input.emitter.emit("cache_hit", { tokens: cacheRead });
      else if (cacheCreate > 0) input.emitter.emit("cache_miss", { reason: "first_call_or_expired", createTokens: cacheCreate });

      // Charge run budget incrementally so we can break the loop early
      const iterCost = computeCost(result.usage?.input_tokens || 0, result.usage?.output_tokens || 0);
      await chargeRunBudget(input.runId, iterCost);
      if (await isOverBudget(input.runId)) {
        status = "budget_exhausted";
        errorMessage = `Hit budget cap (${input.budgetCap} credits) after iter ${iter}`;
        input.emitter.emit("error", { source: "agent_runner", reason: "budget_exhausted", iter, cap: input.budgetCap });
        break;
      }

      // Collect text + tool_use blocks
      let turnText = "";
      const turnToolUses: Array<{ id: string; name: string; input: any }> = [];
      for (const block of result.content) {
        if (block.type === "text") turnText += (block as any).text;
        else if (block.type === "tool_use") {
          turnToolUses.push({ id: (block as any).id, name: (block as any).name, input: (block as any).input });
        }
      }
      finalText += turnText;

      // Loop detection
      const toolSig = turnToolUses.map(tu => `${tu.name}:${JSON.stringify(tu.input)}`).sort().join("|");
      iterHistory.push({ text: turnText, toolSig });
      const loopCheck = detectLoop(iterHistory);
      if (loopCheck.loop) {
        status = "loop_detected";
        errorMessage = `Loop detected (${loopCheck.reason})`;
        input.emitter.emit("error", {
          source: "loop_detector", iter,
          reason: loopCheck.reason, signature: loopCheck.signature,
        });
        break;
      }

      // No tool calls → done
      if (turnToolUses.length === 0) break;

      // Append assistant turn
      const assistantBlocks: any[] = [];
      if (turnText) assistantBlocks.push({ type: "text", text: turnText });
      for (const tu of turnToolUses) assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      messages.push({ role: "assistant", content: assistantBlocks });

      // Execute tools
      const toolResults: any[] = [];
      for (const tu of turnToolUses) {
        const callHandle = input.emitter.emit("tool_call", { name: tu.name, args: tu.input, toolUseId: tu.id, iter });
        const t0 = Date.now();
        let toolResult: string;
        let success = true;
        try {
          toolResult = await executeAnyTool(tu.name, tu.input, ctx, input.composioToolNames, input.builtinTools);
        } catch (err: any) {
          toolResult = `Tool error: ${err?.message || err}`;
          success = false;
          input.emitter.emit("error",
            { source: "tool", name: tu.name, message: err?.message || String(err), iter },
            { parentClientId: callHandle.clientId },
          );
        }
        const dt = Date.now() - t0;
        input.emitter.emit("tool_result", {
          name: tu.name, success,
          resultPreview: toolResult.length > 500 ? toolResult.slice(0, 500) + "…" : toolResult,
          resultLength: toolResult.length,
          toolUseId: tu.id, iter,
        }, { durationMs: dt, parentClientId: callHandle.clientId });
        toolCalls.push({ name: tu.name, args: tu.input, result: toolResult, durationMs: dt });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: toolResult });
      }
      messages.push({ role: "user", content: toolResults });
    }
  } catch (e: any) {
    status = "failed";
    errorMessage = e?.message || String(e);
    input.emitter.emit("error", { source: "agent_runner", message: errorMessage });
  }

  const costCredits = computeCost(totalIn, totalOut);

  return {
    finalText, toolCalls, artifactsCreated: ctx.artifactsCreated,
    totalInputTokens: totalIn, totalOutputTokens: totalOut,
    totalCacheReadTokens: totalCacheRead, totalCacheCreateTokens: totalCacheCreate,
    costCredits,
    iterations: iter + 1,
    status, errorMessage,
  };
}
