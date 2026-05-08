import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAgent, updateAgent, deleteAgent } from "@/lib/db";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const a = await getAgent(params.id, user.id);
  if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ agent: a });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const fields = await req.json().catch(() => ({}));
  await updateAgent(params.id, user.id, fields);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteAgent(params.id, user.id);
  return NextResponse.json({ ok: true });
}
