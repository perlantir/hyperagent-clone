import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { updateSchedule, deleteSchedule } from "@/lib/db";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { active } = await req.json().catch(() => ({}));
  if (typeof active === "number") await updateSchedule(params.id, { active });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteSchedule(params.id, user.id);
  return NextResponse.json({ ok: true });
}
