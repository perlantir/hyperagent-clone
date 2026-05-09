// P49 — In-message fork.
//
// Like the run-based /api/traces/[id]/fork endpoint, but driven by a
// specific message id within a thread instead of a trace run. The chat
// view exposes a "Fork from here" action on user messages; clicking it
// creates a new thread containing every message up to (and including)
// that point. The user lands in the fork ready to edit + re-send.
//
// Body: { fromMessageId: string }
//   - All messages with createdAt <= fromMessageId.createdAt copy across.
//   - Original thread is untouched (the fork is a true copy-on-branch).
//   - Title becomes "Fork: <orig title>" so the sidebar makes the
//     relationship obvious.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getThread, createThread, createMessage } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const fromMessageId = String(body.fromMessageId || "");
  if (!fromMessageId) {
    return NextResponse.json({ error: "fromMessageId required" }, { status: 400 });
  }

  const orig = await getThread(params.id, user.id);
  if (!orig) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  // Resolve the originating message + verify it belongs to this thread.
  const targetRow = await pool().query(
    `SELECT * FROM messages WHERE id=$1 AND "threadId"=$2`,
    [fromMessageId, params.id],
  );
  const target = targetRow.rows[0];
  if (!target) return NextResponse.json({ error: "message not in this thread" }, { status: 404 });

  // Pull every message up to AND including the originating message.
  const allPriorMsgs = await pool().query(
    `SELECT * FROM messages
     WHERE "threadId"=$1 AND "createdAt" <= $2
     ORDER BY "createdAt" ASC`,
    [params.id, target.createdAt],
  );

  const newThread = await createThread(
    user.id,
    `Fork: ${orig.title}`,
    orig.agentId,
    orig.projectId,
  );

  for (const m of allPriorMsgs.rows) {
    await createMessage({
      threadId: newThread.id,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
      artifactIds: m.artifactIds ? JSON.parse(m.artifactIds) : undefined,
      model: m.model || undefined,
      costCredits: m.costCredits ?? undefined,
      attachments: m.attachments ? JSON.parse(m.attachments) : undefined,
    });
  }

  return NextResponse.json({
    ok: true,
    threadId: newThread.id,
    fromMessageId,
    copiedMessages: allPriorMsgs.rows.length,
  });
}
