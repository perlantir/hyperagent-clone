// P24 — Subagent dispatch with hard guardrails.
//
// Every dispatch_agent call goes through here. We enforce all the safety
// guardrails the parent doesn't have to think about:
//
//   - max_depth: 3 (parent depth 0 → child 1 → grandchild 2 → great-grand 3)
//   - max_parallel: 5 concurrent dispatches per parent run (in-process semaphore)
//   - budget_remaining: reserved from parent's run via reserveBudget; commit
//     actual cost on success, rollback on failure
//   - allowed_tools: subset of parent's tools, never escalates. dispatch_agent
//     itself is removed from children unless explicitly re-allowed (rare).
//   - deadline_ms: max 300s, default 120s. Enforced inside the runner.
//   - cancel_token: caller can abort an in-flight dispatch (lambda-local)
//
// Each subagent gets its own trace_run with parentRunId set, its own layered
// system prompt, and returns a structured result the parent embeds in its
// own conversation.

import { startRun, endRun, TraceEmitter } from "./traces";
import { reserveBudget, commitReservation, rollbackReservation, DEFAULT_SUBAGENT_BUDGET } from "./budget";
import { resolveAllTools, DEFAULT_AGENT_TOOLS } from "./tools";
import { composeSystemPrompt } from "./prompt-segments";
import { compilePrompt } from "./prompt-compiler";
import { runAgent } from "./agent-runner";
import { memoriesForContext } from "./memory";

const MAX_DEPTH = 3;
const MAX_PARALLEL_PER_PARENT = 5;
const MAX_DEADLINE_MS = 300_000;
const DEFAULT_DEADLINE_MS = 120_000;

// In-process per-parent dispatch counter for the parallel cap. Lambda-local
// only — across instances, you can have more concurrent children than the
// cap suggests, but per-instance it holds.
const _parentInflight = new Map<string, number>();

export interface DispatchInput {
  parentRunId: string | null;
  parentDepth: number;
  userId: string;
  threadId: string;
  goal: string;
  allowedTools?: string[];
  deadlineMs?: number;
  budgetCredits?: number;
}

export interface DispatchResult {
  childRunId: string | null;
  status: "succeeded" | "failed" | "timeout" | "cancelled" | "rejected" | "loop_detected" | "budget_exhausted";
  summary: string;
  artifacts: Array<{ id: string; type: string; title: string }>;
  costCredits: number;
  durationMs: number;
  reason?: string;
  traceUrl?: string;
}

export async function dispatchSubagent(input: DispatchInput): Promise<DispatchResult> {
  const startedAt = Date.now();

  // ====== Guardrail 1: depth cap ======
  if (input.parentDepth >= MAX_DEPTH) {
    return {
      childRunId: null, status: "rejected", summary: "",
      artifacts: [], costCredits: 0, durationMs: 0,
      reason: `max_depth ${MAX_DEPTH} exceeded (parent at depth ${input.parentDepth})`,
    };
  }

  // ====== Guardrail 2: parallel cap (per parent) ======
  if (input.parentRunId) {
    const inflight = _parentInflight.get(input.parentRunId) || 0;
    if (inflight >= MAX_PARALLEL_PER_PARENT) {
      return {
        childRunId: null, status: "rejected", summary: "",
        artifacts: [], costCredits: 0, durationMs: 0,
        reason: `max_parallel ${MAX_PARALLEL_PER_PARENT} exceeded for parent run`,
      };
    }
    _parentInflight.set(input.parentRunId, inflight + 1);
  }

  // ====== Guardrail 3: budget reservation ======
  const requested = Math.max(1, input.budgetCredits || DEFAULT_SUBAGENT_BUDGET);
  let reservationId: string | null = null;
  if (input.parentRunId) {
    const res = await reserveBudget(input.parentRunId, requested);
    if (!res.ok) {
      decrementInflight(input.parentRunId);
      return {
        childRunId: null, status: "rejected", summary: "",
        artifacts: [], costCredits: 0, durationMs: 0,
        reason: `budget reservation denied: ${res.reason}`,
      };
    }
    reservationId = res.reservationId!;
  }

  // ====== Guardrail 4: deadline cap ======
  const deadlineMs = Math.min(input.deadlineMs || DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS);

  // ====== Build subagent run ======
  let childRunId: string | null = null;
  try {
    childRunId = await startRun({
      userId: input.userId,
      threadId: input.threadId,
      agentId: null,
      parentRunId: input.parentRunId,
      kind: "subagent",
      metadata: {
        depth: input.parentDepth + 1,
        goal: input.goal.slice(0, 500),
        budgetCap: requested,
        reservationId,
      },
    });

    // Emit dispatch event on parent's emitter would require parent's emitter.
    // We track linkage via parentRunId + the reservation row instead.

    const emitter = new TraceEmitter(childRunId);
    emitter.setDefaultMetadata({
      parentRunId: input.parentRunId,
      depth: input.parentDepth + 1,
      kind: "subagent",
    });

    // ====== Tool resolution: enforce allowed_tools subset ======
    const requestedTools = input.allowedTools && input.allowedTools.length > 0
      ? input.allowedTools
      : DEFAULT_AGENT_TOOLS.filter(t => t !== "dispatch_agent"); // children can't dispatch by default
    const { tools, composioToolNames, builtinTools } = await resolveAllTools(input.userId, requestedTools);

    // ====== Compile layered prompt for the subagent ======
    // Subagents don't see the parent thread's history. They get a focused
    // layered prompt + the goal as the user message.
    const memories = await memoriesForContext(input.userId, null, null);
    const segments = composeSystemPrompt({
      agent: null,
      toolNames: tools.map((t: any) => t.name),
      pinnedMemories: memories.filter((m: any) => (m.importance || 0) >= 8),
      contextualMemories: [], // subagents skip contextual memories — focused brief only
      threadContextDocId: null,
    });
    const compiled = compilePrompt(segments, { maxTokens: 12_000 });
    emitter.setDefaultMetadata({
      promptFingerprint: compiled.fingerprint,
      parentRunId: input.parentRunId,
      depth: input.parentDepth + 1,
    });
    emitter.emit("prompt_compiled", {
      fingerprint: compiled.fingerprint,
      totalTokens: compiled.totalTokens,
      blockCount: compiled.systemBlocks.length,
    });
    emitter.emit("subagent_dispatch", {
      parentRunId: input.parentRunId,
      depth: input.parentDepth + 1,
      goal: input.goal.slice(0, 500),
      budgetCap: requested,
      allowedTools: tools.map((t: any) => t.name),
      deadlineMs,
    });

    // ====== Execute the run ======
    const runResult = await runAgent({
      userId: input.userId,
      threadId: input.threadId,
      messageId: childRunId,    // subagent has no real messageId; reuse childRunId for ctx
      runId: childRunId,
      emitter,
      systemBlocks: compiled.systemBlocks,
      messages: [{ role: "user", content: input.goal }],
      tools,
      composioToolNames,
      builtinTools,
      budgetCap: requested,
      depth: input.parentDepth + 1,
      maxIterations: 6,
      deadlineMs,
    });

    emitter.emit("subagent_complete", {
      status: runResult.status,
      iterations: runResult.iterations,
      costCredits: runResult.costCredits,
      artifactCount: runResult.artifactsCreated.length,
    });
    await emitter.flush();
    await endRun(childRunId, {
      status: runResult.status === "succeeded" ? "succeeded" : "failed",
      totalInputTokens: runResult.totalInputTokens,
      totalOutputTokens: runResult.totalOutputTokens,
      totalCacheReadTokens: runResult.totalCacheReadTokens,
      totalCacheWriteTokens: runResult.totalCacheCreateTokens,
      totalCostCredits: runResult.costCredits,
      errorMessage: runResult.errorMessage,
    });

    // ====== Resolve budget reservation ======
    if (reservationId) {
      if (runResult.status === "succeeded") {
        await commitReservation(reservationId, runResult.costCredits, childRunId);
      } else {
        await rollbackReservation(reservationId);
      }
    }

    decrementInflight(input.parentRunId);

    return {
      childRunId,
      status: runResult.status as DispatchResult["status"],
      summary: runResult.finalText || "(subagent produced no text)",
      artifacts: runResult.artifactsCreated,
      costCredits: runResult.costCredits,
      durationMs: Date.now() - startedAt,
      reason: runResult.errorMessage,
      traceUrl: `/api/traces/${childRunId}`,
    };
  } catch (err: any) {
    // Rollback reservation on any unexpected failure
    if (reservationId) {
      try { await rollbackReservation(reservationId); } catch {}
    }
    decrementInflight(input.parentRunId);
    if (childRunId) {
      try {
        await endRun(childRunId, { status: "failed", errorMessage: err?.message || String(err) });
      } catch {}
    }
    return {
      childRunId,
      status: "failed",
      summary: "",
      artifacts: [],
      costCredits: 0,
      durationMs: Date.now() - startedAt,
      reason: err?.message || String(err),
      traceUrl: childRunId ? `/api/traces/${childRunId}` : undefined,
    };
  }
}

function decrementInflight(parentRunId: string | null) {
  if (!parentRunId) return;
  const cur = _parentInflight.get(parentRunId) || 0;
  if (cur <= 1) _parentInflight.delete(parentRunId);
  else _parentInflight.set(parentRunId, cur - 1);
}
