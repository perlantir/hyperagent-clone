// Vercel-compatible scheduler. The /api/cron route is hit every minute by
// Vercel Cron and calls runDueSchedules(). Each schedule is run if its
// (lastRunAt + intervalMinutes) is past.

import {
  listAllActiveSchedules, updateSchedule, getSchedule, getAgent,
  createRun, updateRun, createThread, createMessage, updateMessage,
} from "./db";
import { clientForUser, DEFAULT_MODEL } from "./llm";
import { resolveAllTools } from "./tools";
import { computeCost, chargeCredits, balance } from "./credits";
import { startRun, endRun, TraceEmitter } from "./traces";
import { withRetry } from "./providers";
import { setBudgetCap, DEFAULT_SCHEDULED_RUN_BUDGET } from "./budget";

export async function runDueSchedules(): Promise<{ ran: number; skipped: number; errors: number }> {
  const schedules = await listAllActiveSchedules();
  const now = Date.now();
  let ran = 0, skipped = 0, errors = 0;
  for (const s of schedules) {
    const due = !s.lastRunAt || (now - s.lastRunAt) >= s.intervalMinutes * 60_000;
    if (!due) { skipped++; continue; }
    try {
      await runSchedule(s.id);
      ran++;
    } catch (e) {
      console.error("[scheduler]", s.id, e);
      errors++;
    }
  }
  return { ran, skipped, errors };
}

async function runSchedule(scheduleId: string) {
  const s = await getSchedule(scheduleId);
  if (!s || !s.active) return;
  if ((await balance(s.userId)) <= 0) {
    console.warn(`[scheduler] skipping ${scheduleId} — out of credits`);
    return;
  }
  await updateSchedule(scheduleId, { lastRunAt: Date.now() });
  const startedAt = Date.now();
  const run = await createRun({ scheduleId, threadId: null, status: "running", output: "", startedAt, endedAt: null });

  // P28a — start a trace run alongside the scheduler run.
  const traceRunId = await startRun({
    userId: s.userId, agentId: s.agentId,
    kind: "scheduled",
    metadata: { scheduleId, scheduleName: s.name, scheduleRunId: run.id },
  });
  const emitter = new TraceEmitter(traceRunId);

  // P27a — set per-run cap. Scheduled runs have higher cap than chat turns
  // since users explicitly opt into recurring runs.
  await setBudgetCap(traceRunId, DEFAULT_SCHEDULED_RUN_BUDGET);
  emitter.emit("budget_reserved", { runId: traceRunId, capCredits: DEFAULT_SCHEDULED_RUN_BUDGET, scope: "scheduled" });
  let totalIn = 0, totalOut = 0, cost = 0;
  let status: "succeeded" | "failed" = "succeeded";
  let errMsg: string | undefined;

  try {
    const agent = await getAgent(s.agentId, s.userId);
    if (!agent) throw new Error("Agent not found");

    const thread = await createThread(s.userId, `[Live] ${s.name}`, agent.id);
    await createMessage({ threadId: thread.id, role: "user", content: s.prompt });
    const assistantMsg = await createMessage({ threadId: thread.id, role: "assistant", content: "" });

    const { tools } = await resolveAllTools(s.userId, agent.tools);
    const ant = await clientForUser(s.userId);
    const llmStart = Date.now();
    // P29 — retry transient failures (Anthropic 529, network blips). Auth
    // errors, malformed requests, and context-overflow fail through
    // immediately without retry.
    const result = await withRetry(
      () => ant.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: agent.systemPrompt,
        messages: [{ role: "user", content: s.prompt }],
        tools: tools as any,
      }),
      {
        maxAttempts: 3,
        onRetry: (attempt, classified, delayMs) => {
          emitter.emit("retry", {
            attempt, errorClass: classified.class, reason: classified.reason,
            status: classified.status, delayMs,
          });
        },
      },
    );
    const llmDuration = Date.now() - llmStart;

    totalIn = result.usage?.input_tokens ?? 0;
    totalOut = result.usage?.output_tokens ?? 0;
    emitter.emit("llm_call", {
      model: DEFAULT_MODEL,
      inputTokens: totalIn,
      outputTokens: totalOut,
      stopReason: result.stop_reason,
    }, { durationMs: llmDuration });

    let text = "";
    for (const b of result.content) if (b.type === "text") text += b.text;

    cost = computeCost(totalIn, totalOut);
    await chargeCredits(s.userId, cost, "Scheduled run", run.id);
    await updateMessage(assistantMsg.id, { content: text });

    await updateRun(run.id, { status: "ok", output: text.slice(0, 4000), threadId: thread.id, endedAt: Date.now() });
  } catch (e: any) {
    status = "failed";
    errMsg = e?.message || String(e);
    emitter.emit("error", { source: "scheduler", message: errMsg });
    await updateRun(run.id, { status: "error", output: errMsg!, endedAt: Date.now() });
  }

  // Always finalize the trace, success or failure.
  try {
    await emitter.flush();
    await endRun(traceRunId, {
      status,
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalCostCredits: cost,
      errorMessage: errMsg,
    });
  } catch (traceErr) {
    console.error("[trace finalize scheduler]", traceErr);
  }
}
