// P25 — Memory CRUD API.
//   GET  /api/memories?state=proposed|accepted|all  → list user's memories
//   POST /api/memories  → propose a new memory (alternative to save_memory tool)

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listMemoriesByState, proposeMemory, type MemoryState, type MemoryCategory } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_CATEGORIES: MemoryCategory[] = [
  "user_fact", "preference", "project_context", "domain_knowledge",
  "people", "active_work", "tools_and_workflows", "organization",
];

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const state = (url.searchParams.get("state") || "all") as MemoryState | "all";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);

  const memories = await listMemoriesByState(user.id, state, limit);
  return NextResponse.json({
    memories,
    counts: {
      total: memories.length,
      proposed: memories.filter((m: any) => m.state === "proposed").length,
      accepted: memories.filter((m: any) => m.state === "accepted").length,
    },
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (!body.content || typeof body.content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  if (body.category && !VALID_CATEGORIES.includes(body.category)) {
    return NextResponse.json({ error: "invalid category" }, { status: 400 });
  }

  const result = await proposeMemory({
    userId: user.id,
    content: body.content,
    category: body.category,
    importance: body.importance,
    whenToUse: body.whenToUse,
    tags: body.tags,
    pinned: body.pinned,
    agentId: body.agentId || null,
    projectId: body.projectId || null,
    forceState: body.forceState,  // user-initiated saves can force-accept
  });
  return NextResponse.json(result);
}
