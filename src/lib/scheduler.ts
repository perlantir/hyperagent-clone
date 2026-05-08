// In-process scheduler for Live mode (Phase 5).
// Polls active schedules every minute. When a schedule is due, runs the agent
// against its prompt and saves a Run record. Charges the user credits.

import {
  listAllActiveSchedules, updateSchedule, getSchedule, getAgent,
  createRun, updateRun, createThread, createMessage,
} from "./db";
import { client, DEFAULT_MODEL } from "./llm";
import { resolveTools, toolDefsForAnthropic, executeTool } from "./tools";
import { computeCost, chargeCredits, balance } from "./credits";

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startScheduler() {
  if (started) return;
  started = true;
  console.log("[scheduler] started");
  timer = setInterval(tick, 60_000);
  setTimeout(tick, 5_000);
}

async function tick() {
  try {
    const schedules = listAllActiveSchedules();
    const now = Date.now();
    for (const s of schedules) {
      const due = !s.lastRunAt || (now - s.lastRunAt) >= s.intervalMinutes * 60_000;
      if (due) runSchedule(s.id).catch(e => console.error("[scheduler]", e));
    }
  } catch (e) { console.error("[scheduler tick]", e); }
}

async function runSchedule(scheduleId: string) {
  const s = getSchedule(scheduleId);
  if (!s || !s.active) return;
  if (balance(s.userId) <= 0) {
    console.warn(`[scheduler] skipping ${scheduleId} — out of credits`);
    return;
  }
  console.log(`[scheduler] running ${scheduleId}`);
  updateSchedule(scheduleId, { lastRunAt: Date.now() });

  const startedAt = Date.now();
  const run = createRun({ scheduleId, threadId: null, status: "running", output: "", startedAt, endedAt: null });

  try {
    const agent = getAgent(s.agentId, s.userId);
    if (!agent) throw new Error("Agent not found");

    const thread = createThread(s.userId, `[Live] ${s.name}`, agent.id);
    const userMsg = createMessage({ threadId: thread.id, role: "user", content: s.prompt });
    const assistantMsg = createMessage({ threadId: thread.id, role: "assistant", content: "" });

    const tools = await resolveTools(agent.tools, s.userId);
    const result = await client().messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system: agent.systemPrompt,
      messages: [{ role: "user", content: s.prompt }],
      tools: toolDefsForAnthropic(tools) as any,
    });

    let text = "";
    for (const b of result.content) if (b.type === "text") text += b.text;

    const cost = computeCost(result.usage?.input_tokens ?? 0, result.usage?.output_tokens ?? 0);
    chargeCredits(s.userId, cost, "Scheduled run", run.id);
    const { updateMessage } = await import("./db");
    updateMessage(assistantMsg.id, { content: text });

    updateRun(run.id, { status: "ok", output: text.slice(0, 4000), threadId: thread.id, endedAt: Date.now() });
  } catch (e: any) {
    updateRun(run.id, { status: "error", output: e?.message || String(e), endedAt: Date.now() });
    console.error(`[scheduler] ${run.id} error`, e);
  }
}
