import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { deleteSkill } from "@/lib/db";

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteSkill(params.id, user.id);
  return NextResponse.json({ ok: true });
}
