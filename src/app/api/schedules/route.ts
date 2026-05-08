import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listSchedules, createSchedule } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ schedules: await listSchedules(user.id) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { agentId, prompt, intervalMinutes } = await req.json().catch(() => ({}));
  if (!agentId || !prompt) return NextResponse.json({ error: "agentId and prompt required" }, { status: 400 });
  const s = await createSchedule({
    userId: user.id,
    agentId,
    prompt,
    intervalMinutes: Math.max(1, intervalMinutes || 60),
    active: 1,
  });
  return NextResponse.json({ schedule: s });
}
