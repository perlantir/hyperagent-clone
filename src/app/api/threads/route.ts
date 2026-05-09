import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listThreads, createThread } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // P50 — ?archived=1 surfaces archived threads for the dedicated "Show
  // archived" filter view; default hides them.
  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("archived") === "1";
  return NextResponse.json({ threads: await listThreads(user.id, undefined, { includeArchived }) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { title, agentId, projectId } = await req.json().catch(() => ({}));
  const t = await createThread(user.id, title || "New thread", agentId || null, projectId || null);
  return NextResponse.json({ thread: t });
}
