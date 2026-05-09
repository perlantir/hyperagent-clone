// P51 — Manual "Run now" for a schedule.
//
// Lets the user immediately trigger a schedule's prompt against its agent
// without waiting for the cron tick. Critical for verifying a schedule
// works as expected (and the #1 thing that makes "schedules don't work"
// debuggable — instead of waiting overnight to see if it ran, click run-
// now and watch the output land within seconds).
//
// Internally just calls runSchedule via the existing runDueSchedules path.
// We don't need exact one-shot execution; we just bypass the "is it due?"
// check by clearing lastRunAt + delegating to the scheduler's standard
// flow so all the trace + budget + error-handling stays consistent with
// cron-fired runs.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getSchedule, updateSchedule, getAgent, createThread, createMessage, updateMessage, createRun, updateRun } from "@/lib/db";
import { clientForUser, DEFAULT_MODEL } from "@/lib/llm";
import { resolveAllTools } from "@/lib/tools";
import { computeCost, chargeCredits, balance } from "@/lib/credits";
import { startRun, endRun, TraceEmitter } from "@/lib/traces";
import { withRetry } from "@/lib/providers";
import { setBudgetCap, DEFAULT_SCHEDULED_RUN_BUDGET } from "@/lib/budget";
import { composeSystemPrompt } from "@/lib/prompt-segments";
import { compilePrompt } from "@/lib/prompt-compiler";
import { retrieveMemoriesForChat } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const s = await getSchedule(params.id);
  if (!s || s.userId !== user.id) {
    return NextResponse.json({ error: "schedule not found" }, { status: 404 });
  }
  if ((await balance(user.id)) <= 0) {
    return NextResponse.json({ error: "insufficient credits — top up to run schedules" }, { status: 402 });
  }

  // Stamp lastRunAt up front so a parallel cron tick won't double-fire.
  await updateSchedule(params.id, { lastRunAt: Date.now() });
  const startedAt = Date.now();
  const run = await createRun({ scheduleId: s.id, threadId: null, status: "running", output: "", startedAt, endedAt: null });

  const traceRunId = await startRun({
    userId: s.userId, agentId: s.agentId,
    kind: "scheduled",
    metadata: { scheduleId: s.id, scheduleName: s.name, scheduleRunId: run.id, manual: true },
  });
  const emitter = new TraceEmitter(traceRunId);
  await setBudgetCap(traceRunId, DEFAULT_SCHEDULED_RUN_BUDGET);
  emitter.emit("budget_reserved", { runId: traceRunId, capCredits: DEFAULT_SCHEDULED_RUN_BUDGET, scope: "scheduled" });

  let totalIn = 0, totalOut = 0, cost = 0;
  let status: "succeeded" | "failed" = "succeeded";
  let errMsg: string | undefined;
  let outputText = "";
  let threadId: string | null = null;

  try {
    const agent = await getAgent(s.agentId, s.userId);
    if (!agent) throw new Error("Agent for this schedule was deleted");

    const thread = await createThread(s.userId, `[Live] ${s.name}`, agent.id);
    threadId = thread.id;
    await createMessage({ threadId: thread.id, role: "user", content: s.prompt });
    const assistantMsg = await createMessage({ threadId: thread.id, role: "assistant", content: "" });

    const { tools } = await resolveAllTools(s.userId, agent.tools, {
      connectorIds: agent.connectorIds,
      connectorScopes: agent.connectorScopes,
    });

    const { pinned: pinnedMemories, contextual: contextualMemories } =
      await retrieveMemoriesForChat(s.userId, agent.id, null, s.prompt);
    const segments = composeSystemPrompt({
      agent, toolNames: tools.map((t: any) => t.name),
      pinnedMemories, contextualMemories, threadContextDocId: null,
    });
    const compiled = compilePrompt(segments, { maxTokens: 16_000 });
    emitter.setDefaultMetadata({ promptFingerprint: compiled.fingerprint, agentId: agent.id });

    const ant = await clientForUser(s.userId);
    const llmStart = Date.now();
    const result = await withRetry(
      () => ant.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: compiled.systemBlocks as any,
        messages: [{ role: "user", content: s.prompt }],
        tools: tools as any,
      }),
      { maxAttempts: 3 },
    );
    totalIn = result.usage?.input_tokens ?? 0;
    totalOut = result.usage?.output_tokens ?? 0;
    emitter.emit("llm_call", {
      model: DEFAULT_MODEL, inputTokens: totalIn, outputTokens: totalOut,
      stopReason: result.stop_reason,
    }, { durationMs: Date.now() - llmStart });

    for (const b of result.content) if (b.type === "text") outputText += b.text;
    cost = computeCost(totalIn, totalOut);
    await chargeCredits(s.userId, cost, "Scheduled run (manual)", run.id);
    await updateMessage(assistantMsg.id, { content: outputText });

    await updateRun(run.id, { status: "ok", output: outputText.slice(0, 4000), threadId: thread.id, endedAt: Date.now() });
  } catch (e: any) {
    status = "failed";
    errMsg = e?.message || String(e);
    emitter.emit("error", { source: "schedule_manual_run", message: errMsg });
    await updateRun(run.id, { status: "error", output: errMsg!, endedAt: Date.now() });
  }

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
    console.error("[trace finalize manual schedule]", traceErr);
  }

  return NextResponse.json({
    ok: status === "succeeded",
    runId: run.id,
    threadId,
    output: outputText.slice(0, 4000),
    error: errMsg || null,
  });
}
