import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getProject, deleteProject, updateProject, listThreads, listAgents, listMemories, listArtifactsForUser } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const p = await getProject(params.id, user.id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  const threads = (await listThreads(user.id, params.id));
  const agents = (await listAgents(user.id)).filter(a => a.projectId === params.id);
  const memories = await listMemories(user.id, { projectId: params.id });
  // P53 — every artifact emitted from any thread in this project
  // surfaces on the project canvas.
  const artifacts = (await listArtifactsForUser(user.id, { projectId: params.id }));
  return NextResponse.json({ project: p, threads, agents, memories, artifacts });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const patch: any = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.description === "string") patch.description = body.description;
  if (typeof body.color === "string" && /^[a-z]+$/.test(body.color)) patch.color = body.color;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no editable fields provided" }, { status: 400 });
  }
  const updated = await updateProject(params.id, user.id, patch);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ project: updated });
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteProject(params.id, user.id);
  return NextResponse.json({ ok: true });
}
