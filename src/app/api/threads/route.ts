import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listThreads, createThread } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ threads: listThreads(user.id) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { title, agentId } = await req.json().catch(() => ({}));
  const t = createThread(user.id, title || "New thread", agentId || null);
  return NextResponse.json({ thread: t });
}
