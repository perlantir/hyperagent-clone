// P40 — Per-agent knowledge documents.
//
//   GET  /api/agents/{agentId}/knowledge → { docs }
//   POST /api/agents/{agentId}/knowledge   body: { title, content, sourceUrl? } → { doc, chunkCount }
//
// Authz: agent must belong to the requesting user. Persisted via
// lib/knowledge.ts which handles chunking + embedding.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAgent } from "@/lib/db";
import { createKnowledgeDoc, listKnowledgeDocs } from "@/lib/knowledge";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;  // chunking + embedding can take a while

const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB hard cap on doc body

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const agent = await getAgent(params.id, user.id);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const docs = await listKnowledgeDocs(user.id, agent.id);
  return NextResponse.json({ docs });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const agent = await getAgent(params.id, user.id);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const title = String(body.title || "").trim();
  const content = String(body.content || "");
  const sourceUrl = body.sourceUrl ? String(body.sourceUrl).slice(0, 1000) : null;

  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  if (!content.trim()) return NextResponse.json({ error: "content required" }, { status: 400 });
  if (Buffer.byteLength(content, "utf-8") > MAX_CONTENT_BYTES) {
    return NextResponse.json({ error: `content exceeds ${MAX_CONTENT_BYTES / 1024 / 1024}MB cap` }, { status: 413 });
  }

  const { doc, chunkCount } = await createKnowledgeDoc({
    userId: user.id, agentId: agent.id,
    title, content, sourceUrl,
  });

  await audit({
    userId: user.id, action: "memory.write",
    resource: doc.id, result: "success",
    metadata: { source: "knowledge", agentId: agent.id, chunkCount, byteSize: doc.byteSize },
    ...auditFromRequest(req),
  });

  return NextResponse.json({ doc, chunkCount });
}
