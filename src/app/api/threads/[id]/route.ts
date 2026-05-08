import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getThread, listMessages, updateThread, deleteThread } from "@/lib/db";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const t = await getThread(params.id, user.id);
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
  const messages = await listMessages(t.id);
  return NextResponse.json({ thread: t, messages });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const fields = await req.json().catch(() => ({}));
  await updateThread(params.id, user.id, fields);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteThread(params.id, user.id);
  return NextResponse.json({ ok: true });
}
