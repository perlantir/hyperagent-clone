// P28b — Replay a run.
//
// Looks up the user message that started the original run, creates a NEW
// thread (so the original is preserved untouched), copies that message in
// as a draft (role=user), and points the response at the new thread.
//
// We do NOT auto-trigger the chat lambda — chat is a streaming SSE endpoint
// owned by the client. The /threads/{id} page sees the seeded message and
// the user clicks Send (or we add a query param to auto-send — TODO P30).
//
// "Replay" semantics: against the agent's CURRENT state. So if the agent's
// system prompt changed between the original run and now, the replay shows
// what the new agent would do. To replay against the historical state, use
// rollbackAgentToVersion first or fork instead.

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

  // The trace_runs.messageId points to the assistant message created by
  // this run. The user's input is the message immediately BEFORE that one
  // in the original thread. Find it.
  if (!run.threadId) return NextResponse.json({ error: "run has no thread" }, { status: 400 });

  const orig = await getThread(run.threadId, user.id);
  if (!orig) return NextResponse.json({ error: "original thread not found" }, { status: 404 });

  // Find the user message that immediately preceded this run's assistant message.
  const r = await pool().query(
    `SELECT * FROM messages
     WHERE "threadId"=$1 AND role='user' AND "createdAt" < (
       SELECT "createdAt" FROM messages WHERE id=$2
     )
     ORDER BY "createdAt" DESC LIMIT 1`,
    [run.threadId, run.messageId],
  );
  const userMsg = r.rows[0];
  if (!userMsg) {
    return NextResponse.json({ error: "could not locate originating user message" }, { status: 404 });
  }

  // Create a new thread, point it at the same agent. Title prefix marks it.
  const newThread = await createThread(
    user.id,
    `Replay: ${orig.title}`,
    orig.agentId,
    orig.projectId,
  );
  // Don't write the user message yet — we want the user to see it staged
  // in the input box, edit if needed, then hit Send. Pass via query string
  // or local-storage handoff. For now, write the message into the thread
  // marked with a metadata flag so the chat UI can render it as "replay seed"
  // and the user just hits send to rerun.
  // Simpler approach: write a system-marker message that the UI hides, plus
  // pass the seed via the URL fragment.

  return NextResponse.json({
    ok: true,
    threadId: newThread.id,
    seed: userMsg.content,
    fromRunId: run.id,
  });
}
