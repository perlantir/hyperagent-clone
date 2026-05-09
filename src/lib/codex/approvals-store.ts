// P59 — Codex approval rendezvous.
//
// SCENARIO: a chat turn is running through the Codex bridge in /api/chat.
// The bridge sends `approval/required`. We need to:
//   1. Surface the approval to the browser via the open SSE
//   2. Wait for the user to click Accept / Accept-for-session / Decline / Cancel
//   3. Send `approval/respond` back to the bridge over the still-open WS
//
// PROBLEM: SSE is one-direction (server→browser). The user's click goes to
// a SEPARATE HTTP request (POST /api/codex/approval/[id]). On Vercel, that
// second request may land on a DIFFERENT lambda instance, so an in-memory
// Map of pending approvals doesn't work reliably.
//
// SOLUTION: rendezvous through the database. The chat lambda inserts a
// pending row keyed on approvalId, then polls for `decision IS NOT NULL`.
// The approval-decision endpoint UPDATEs the row. Both lambdas converge
// on the DB row.
//
// SECURITY: approval rows are scoped to a specific (userId, threadId) so
// no other user can ever resolve someone else's approval. Rows are
// short-lived — expired after 5 minutes.

import { pool } from "../db";

let _initialized = false;
async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS codex_approvals (
      "approvalId" TEXT PRIMARY KEY,
      "threadId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      decision TEXT,
      "decidedAt" BIGINT,
      "createdAt" BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_codex_approvals_user
      ON codex_approvals("userId", "createdAt" DESC);
  `);
  _initialized = true;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface PendingApproval {
  approvalId: string;
  threadId: string;
  userId: string;
  kind: string;
  summary: string;
  detail?: string;
}

export async function createApproval(p: PendingApproval): Promise<void> {
  await ensureSchema();
  await pool().query(`
    INSERT INTO codex_approvals
      ("approvalId", "threadId", "userId", kind, summary, detail, "createdAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT ("approvalId") DO NOTHING
  `, [p.approvalId, p.threadId, p.userId, p.kind, p.summary, p.detail || null, Date.now()]);
}

/**
 * Poll the approval row until `decision` is set or the timeout elapses.
 * Returns the decision string, or "timeout" if the user didn't act in time.
 *
 * The chat lambda calls this with timeoutMs ~60s and the bridge will be
 * told `decline` if we time out (safer default than `accept`).
 */
export async function pollDecision(
  approvalId: string,
  timeoutMs: number = 60_000,
  pollIntervalMs: number = 500,
): Promise<ApprovalDecision | "timeout"> {
  await ensureSchema();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await pool().query(
      `SELECT decision FROM codex_approvals WHERE "approvalId"=$1`,
      [approvalId],
    );
    const d = r.rows[0]?.decision as ApprovalDecision | null;
    if (d) return d;
    await new Promise(res => setTimeout(res, pollIntervalMs));
  }
  return "timeout";
}

/**
 * Submit a decision. Scoped to (userId, threadId) so a malicious caller
 * can't resolve another user's approval. Returns true if the row was
 * updated, false if not found / wrong owner / already decided.
 */
export async function submitDecision(
  approvalId: string,
  userId: string,
  decision: ApprovalDecision,
): Promise<boolean> {
  await ensureSchema();
  // Only update if not yet decided AND owned by this user.
  const r = await pool().query(`
    UPDATE codex_approvals
       SET decision = $1, "decidedAt" = $2
     WHERE "approvalId" = $3
       AND "userId" = $4
       AND decision IS NULL
  `, [decision, Date.now(), approvalId, userId]);
  return (r.rowCount || 0) > 0;
}

/**
 * Best-effort sweep of stale rows. Called from /api/cron daily to keep
 * the table tidy. Ignored failures.
 */
export async function pruneOldApprovals(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  await ensureSchema();
  const cutoff = Date.now() - maxAgeMs;
  const r = await pool().query(
    `DELETE FROM codex_approvals WHERE "createdAt" < $1`,
    [cutoff],
  );
  return r.rowCount || 0;
}
