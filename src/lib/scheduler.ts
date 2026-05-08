// Vercel-compatible scheduler. The /api/cron route is hit every minute by
// Vercel Cron and calls runDueSchedules(). Each schedule is run if its
// (lastRunAt + intervalMinutes) is past.

import {
  listAllActiveSchedules, updateSchedule, getSchedule, getAgent,
  createRun, updateRun, createThread, createMessage, updateMessage,
} from "./db";
import { client, DEFAULT_MODEL } from "./llm";
import { resolveAllTools } from "./tools";
import { computeCost, chargeCredits, balance } from "./credits";

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

  try {
    const agent = await getAgent(s.agentId, s.userId);
    if (!agent) throw new Error("Agent not found");

    const thread = await createThread(s.userId, `[Live] ${s.name}`, agent.id);
    await createMessage({ threadId: thread.id, role: "user", content: s.prompt });
    const assistantMsg = await createMessage({ threadId: thread.id, role: "assistant", content: "" });

    const { tools } = await resolveAllTools(s.userId, agent.tools);
    const result = await client().messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system: agent.systemPrompt,
      messages: [{ role: "user", content: s.prompt }],
      tools: tools as any,
    });

    let text = "";
    for (const b of result.content) if (b.type === "text") text += b.text;

    const cost = computeCost(result.usage?.input_tokens ?? 0, result.usage?.output_tokens ?? 0);
    await chargeCredits(s.userId, cost, "Scheduled run", run.id);
    await updateMessage(assistantMsg.id, { content: text });

    await updateRun(run.id, { status: "ok", output: text.slice(0, 4000), threadId: thread.id, endedAt: Date.now() });
  } catch (e: any) {
    await updateRun(run.id, { status: "error", output: e?.message || String(e), endedAt: Date.now() });
  }
}
