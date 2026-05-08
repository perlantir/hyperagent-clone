import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listMemories, createMemory } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ memories: listMemories(user.id) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { content, agentId, projectId, importance } = await req.json().catch(() => ({}));
  if (!content) return NextResponse.json({ error: "content required" }, { status: 400 });
  const m = createMemory({ userId: user.id, content, agentId: agentId || null, projectId: projectId || null, importance: importance || 5 });
  return NextResponse.json({ memory: m });
}
