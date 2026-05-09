import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listSchedules, createSchedule } from "@/lib/db";
import { runDueSchedules } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

// P51 — opportunistic firing. When the user opens /live (which lists
// schedules), kick runDueSchedules in the background so any due schedule
// fires now even if the daily cron hasn't ticked yet. Throttled to once
// per 30 seconds globally to avoid hammering the LLM if the page polls.
let lastOpportunisticTick = 0;
function maybeOpportunisticTick() {
  const now = Date.now();
  if (now - lastOpportunisticTick < 30_000) return;
  lastOpportunisticTick = now;
  // Background — failure is logged but doesn't block the GET.
  runDueSchedules().catch(e => console.error("[opportunistic schedule tick]", e));
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  maybeOpportunisticTick();
  return NextResponse.json({ schedules: await listSchedules(user.id) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // P51 — accept name (was previously ignored, defaulted to 'Automation'
  // server-side which surfaced as a confusing "every schedule has the
  // same name" UX bug).
  const { agentId, prompt, intervalMinutes, name } = await req.json().catch(() => ({}));
  if (!agentId || !prompt) return NextResponse.json({ error: "agentId and prompt required" }, { status: 400 });
  const s = await createSchedule({
    userId: user.id,
    agentId,
    prompt,
    intervalMinutes: Math.max(1, intervalMinutes || 60),
    active: 1,
    name: (name && String(name).trim()) || "Automation",
  });
  return NextResponse.json({ schedule: s });
}
