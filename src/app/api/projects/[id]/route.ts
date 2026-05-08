import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getProject, deleteProject, listThreads, listAgents, listMemories } from "@/lib/db";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const p = await getProject(params.id, user.id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  const threads = (await listThreads(user.id)).filter(t => t.projectId === params.id);
  const agents = (await listAgents(user.id)).filter(a => a.projectId === params.id);
  const memories = await listMemories(user.id, { projectId: params.id });
  return NextResponse.json({ project: p, threads, agents, memories });
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteProject(params.id, user.id);
  return NextResponse.json({ ok: true });
}
