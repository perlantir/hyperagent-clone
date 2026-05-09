// P38 — User feedback on a run / thread.
//
//   POST /api/feedback
//   Body: { runId?, threadId?, rating: -1|0|1, text?, scope?: "run"|"thread" }
//   → { ok: true }
//
// Persists feedback into a dedicated table so it can drive learning later
// (training signal for evals, prioritization for improvement proposals).
// Audit-logged so operators see when users push back on output.
//
// Idempotent on (userId, runId | threadId, createdAt) — no dedup beyond
// "submit again to overwrite the prior rating."

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let _initialized = false;
async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "runId" TEXT,
      "threadId" TEXT,
      scope TEXT NOT NULL,
      rating INTEGER NOT NULL,
      text TEXT,
      "createdAt" BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_user_ts ON feedback("userId", "createdAt" DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_run ON feedback("runId");
    CREATE INDEX IF NOT EXISTS idx_feedback_thread ON feedback("threadId");
  `);
  _initialized = true;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureSchema();

  const body = await req.json().catch(() => ({}));
  const runId: string | undefined = body.runId;
  const threadId: string | undefined = body.threadId;
  const rating = Number(body.rating);
  const text: string | undefined = typeof body.text === "string" ? body.text.slice(0, 4000) : undefined;
  const scope: "run" | "thread" = body.scope === "thread" ? "thread" : "run";

  if (![-1, 0, 1].includes(rating)) {
    return NextResponse.json({ error: "rating must be -1, 0, or 1" }, { status: 400 });
  }
  if (!runId && !threadId) {
    return NextResponse.json({ error: "runId or threadId required" }, { status: 400 });
  }

  // Authz — confirm the user owns the referenced thread/run.
  if (threadId) {
    const t = await pool().query(`SELECT 1 FROM threads WHERE id=$1 AND "userId"=$2`, [threadId, user.id]);
    if (!t.rows[0]) return NextResponse.json({ error: "thread not found" }, { status: 404 });
  }
  if (runId) {
    const r = await pool().query(`SELECT 1 FROM trace_runs WHERE id=$1 AND "userId"=$2`, [runId, user.id]);
    if (!r.rows[0]) return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const id = "fb_" + crypto.randomBytes(8).toString("hex");
  await pool().query(
    `INSERT INTO feedback (id, "userId", "runId", "threadId", scope, rating, text, "createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, user.id, runId || null, threadId || null, scope, rating, text || null, Date.now()],
  );

  await audit({
    userId: user.id,
    action: "feedback.submit",
    resource: runId || threadId || null,
    result: "success",
    metadata: { scope, rating, hasText: !!text },
    ...auditFromRequest(req),
  });

  return NextResponse.json({ ok: true, id });
}
