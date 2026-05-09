import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAgent, updateAgent, deleteAgent } from "@/lib/db";
import { snapshotAgent } from "@/lib/agent-versions";

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
  // P28b — snapshot the PRE-edit state before writing the change so the
  // version history captures every prior config. snapshotAgent reads the
  // live row, so we must call it before updateAgent. Best-effort: a failed
  // snapshot shouldn't block the edit (we log + continue).
  try {
    await snapshotAgent(params.id, user.id, fields.changeNote || null);
  } catch (e) {
    console.error("[agent snapshot]", e);
  }
  await updateAgent(params.id, user.id, fields);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteAgent(params.id, user.id);
  return NextResponse.json({ ok: true });
}
