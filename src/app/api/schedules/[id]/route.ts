import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { updateSchedule, deleteSchedule, getSchedule } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const s = await getSchedule(params.id);
  if (!s || s.userId !== user.id) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ schedule: s });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // P51 — verify ownership before mutating; previously /api/schedules/[id]
  // PATCH never checked, so any logged-in user could toggle anyone's
  // schedules just by guessing the id.
  const existing = await getSchedule(params.id);
  if (!existing || existing.userId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const { active, name, prompt, intervalMinutes } = body;
  // Build a clean partial — only fields we accept, only when present.
  const patch: any = {};
  if (typeof active === "number") patch.active = active;
  if (typeof name === "string" && name.trim()) patch.name = name.trim();
  if (typeof prompt === "string" && prompt.trim()) patch.prompt = prompt.trim();
  if (typeof intervalMinutes === "number" && intervalMinutes > 0) patch.intervalMinutes = intervalMinutes;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no editable fields provided" }, { status: 400 });
  }
  await updateSchedule(params.id, patch);
  const fresh = await getSchedule(params.id);
  return NextResponse.json({ schedule: fresh });
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteSchedule(params.id, user.id);
  return NextResponse.json({ ok: true });
}
