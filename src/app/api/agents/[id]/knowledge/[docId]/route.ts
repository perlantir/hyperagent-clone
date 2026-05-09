// P40 — Per-agent knowledge doc detail / delete.
//
//   GET    /api/agents/{agentId}/knowledge/{docId} → { doc }
//   DELETE /api/agents/{agentId}/knowledge/{docId} → { ok }

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAgent } from "@/lib/db";
import { getKnowledgeDoc, deleteKnowledgeDoc } from "@/lib/knowledge";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string; docId: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const agent = await getAgent(params.id, user.id);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const doc = await getKnowledgeDoc(params.docId);
  if (!doc || doc.agentId !== agent.id || doc.userId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ doc });
}

export async function DELETE(req: Request, { params }: { params: { id: string; docId: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const agent = await getAgent(params.id, user.id);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const ok = await deleteKnowledgeDoc(params.docId, user.id);
  await audit({
    userId: user.id, action: "memory.delete", resource: params.docId,
    result: ok ? "success" : "failure",
    metadata: { source: "knowledge", agentId: agent.id },
    ...auditFromRequest(req),
  });
  return NextResponse.json({ ok });
}
