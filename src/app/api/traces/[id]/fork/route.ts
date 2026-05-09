// P28b — Fork a run.
//
// Like replay, but seeds the new thread with the FULL conversation history
// up to (and including) the originating user message — so you can edit the
// user message and re-run from that point with all prior context intact.
//
// Practical use: an assistant turn went off the rails. Fork it, rephrase
// the user's question, watch the new run play out without losing the early
// productive turns.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRun } from "@/lib/traces";
import { pool } from "@/lib/db";
import { getThread, createThread, createMessage } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const run = await getRun(params.id, user.id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  if (!run.threadId) return NextResponse.json({ error: "run has no thread" }, { status: 400 });

  const orig = await getThread(run.threadId, user.id);
  if (!orig) return NextResponse.json({ error: "original thread not found" }, { status: 404 });

  // Pull all messages up to and including the originating user message.
  // We exclude the assistant message that the original run produced (that's
  // what we're rewriting).
  const userMsgRow = await pool().query(
    `SELECT * FROM messages
     WHERE "threadId"=$1 AND role='user' AND "createdAt" < (
       SELECT "createdAt" FROM messages WHERE id=$2
     )
     ORDER BY "createdAt" DESC LIMIT 1`,
    [run.threadId, run.messageId],
  );
  const userMsg = userMsgRow.rows[0];
  if (!userMsg) return NextResponse.json({ error: "could not locate originating user message" }, { status: 404 });

  const allPriorMsgs = await pool().query(
    `SELECT * FROM messages
     WHERE "threadId"=$1 AND "createdAt" < $2
     ORDER BY "createdAt" ASC`,
    [run.threadId, userMsg.createdAt],
  );

  // Create the fork thread.
  const newThread = await createThread(
    user.id,
    `Fork: ${orig.title}`,
    orig.agentId,
    orig.projectId,
  );

  // Copy prior messages into the fork. This is the "branch from this point"
  // semantic — the new thread has its own message rows, so editing them
  // doesn't mutate history.
  for (const m of allPriorMsgs.rows) {
    await createMessage({
      threadId: newThread.id,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
      artifactIds: m.artifactIds ? JSON.parse(m.artifactIds) : undefined,
      model: m.model || undefined,
      costCredits: m.costCredits ?? undefined,
    });
  }

  return NextResponse.json({
    ok: true,
    threadId: newThread.id,
    seed: userMsg.content, // pre-fill the input with the editable user message
    fromRunId: run.id,
  });
}
