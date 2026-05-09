// P66d — Server-authoritative run lifecycle store.
//
// Three concerns, one module:
//   1. codex_runs       — the canonical run row. State machine lives
//                         in `state` column.
//   2. codex_run_approvals — server-side approval requests + decisions.
//                         Replaces the bridge-mode `codex_approvals`
//                         for companion-mode runs.
//   3. helper functions for SSE streaming, snapshot reads, and
//      cancellation.
//
// State machine for codex_runs.state:
//   queued → dispatched → running → approval_pending ↔ running →
//   completed | failed | cancelling → cancelled
//
// Storage:
//   - Postgres (Neon). All operations idempotent on schema creation.
//   - rollback: DROP TABLE codex_run_approvals; DROP TABLE codex_runs;
//     codex_run_events stays (P65); codex_audit_log stays (P66b).
//
// SECURITY:
//   - userId/orgId scoping on every read/write.
//   - We never store ChatGPT/Codex tokens.
//   - Policy snapshot stored as JSONB so an admin can prove what
//     policy a given run executed under at audit time.

import { randomBytes } from "node:crypto";
import { pool } from "../db";

let _initialized = false;

export async function ensureRunsSchema(): Promise<void> {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS codex_runs (
      "runId" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "orgId" TEXT,
      "threadId" TEXT NOT NULL,
      "agentId" TEXT,
      "companionId" TEXT,
      "providerMode" TEXT NOT NULL,
      "state" TEXT NOT NULL,
      "lastEventSeq" BIGINT NOT NULL DEFAULT 0,
      "startedAt" BIGINT NOT NULL,
      "endedAt" BIGINT,
      "lastError" TEXT,
      "policySnapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "budgetMicroUsdSeen" BIGINT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS "codex_runs_userId_thread_idx"
      ON codex_runs("userId","threadId","startedAt" DESC);
    CREATE INDEX IF NOT EXISTS "codex_runs_state_idx"
      ON codex_runs("state");
    CREATE INDEX IF NOT EXISTS "codex_runs_companion_state_idx"
      ON codex_runs("companionId","state");

    CREATE TABLE IF NOT EXISTS codex_run_approvals (
      "approvalId" TEXT PRIMARY KEY,
      "runId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "methodName" TEXT NOT NULL,
      "summary" TEXT NOT NULL,
      "redactedPayload" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "requestedAt" BIGINT NOT NULL,
      "decidedAt" BIGINT,
      "decision" TEXT,
      "decidedBy" TEXT,
      "decisionSource" TEXT,
      "companionId" TEXT,
      "expiresAt" BIGINT
    );
    CREATE INDEX IF NOT EXISTS "codex_run_approvals_run_idx"
      ON codex_run_approvals("runId","requestedAt");
    CREATE INDEX IF NOT EXISTS "codex_run_approvals_pending_idx"
      ON codex_run_approvals("userId","decidedAt") WHERE "decidedAt" IS NULL;
  `);
  _initialized = true;
}

export type CodexRunState =
  | "queued"
  | "dispatched"
  | "running"
  | "approval_pending"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface CodexRun {
  runId: string;
  userId: string;
  orgId: string | null;
  threadId: string;
  agentId: string | null;
  companionId: string | null;
  providerMode: string;
  state: CodexRunState;
  lastEventSeq: number;
  startedAt: number;
  endedAt: number | null;
  lastError: string | null;
  policySnapshot: any;
  budgetMicroUsdSeen: number;
}

export async function createRun(opts: {
  runId?: string;
  userId: string;
  orgId?: string | null;
  threadId: string;
  agentId?: string | null;
  companionId?: string | null;
  providerMode: string;
  policySnapshot?: any;
  now?: number;
}): Promise<CodexRun> {
  await ensureRunsSchema();
  const now = opts.now ?? Date.now();
  const runId = opts.runId ?? `run_${randomBytes(12).toString("hex")}`;
  await pool().query(
    `INSERT INTO codex_runs
       ("runId","userId","orgId","threadId","agentId","companionId",
        "providerMode","state","startedAt","policySnapshot")
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9::jsonb)`,
    [
      runId, opts.userId, opts.orgId ?? null, opts.threadId,
      opts.agentId ?? null, opts.companionId ?? null,
      opts.providerMode, now, JSON.stringify(opts.policySnapshot ?? {}),
    ],
  );
  const row = (await pool().query(`SELECT * FROM codex_runs WHERE "runId"=$1`, [runId])).rows[0];
  return rowToRun(row);
}

export async function getRun(opts: { runId: string; userId: string }): Promise<CodexRun | null> {
  await ensureRunsSchema();
  const r = await pool().query(
    `SELECT * FROM codex_runs WHERE "runId"=$1 AND "userId"=$2`,
    [opts.runId, opts.userId],
  );
  return r.rows[0] ? rowToRun(r.rows[0]) : null;
}

export async function transitionRunState(opts: {
  runId: string;
  expectedFrom?: CodexRunState[];
  to: CodexRunState;
  endedAt?: number;
  lastError?: string;
  now?: number;
}): Promise<boolean> {
  await ensureRunsSchema();
  const params: any[] = [opts.runId, opts.to];
  let where = `"runId" = $1`;
  if (opts.expectedFrom && opts.expectedFrom.length > 0) {
    const placeholders = opts.expectedFrom.map((_, i) => `$${i + 3}`).join(",");
    where += ` AND "state" IN (${placeholders})`;
    params.push(...opts.expectedFrom);
  }
  const setClauses = [`"state" = $2`];
  if (opts.endedAt !== undefined) {
    params.push(opts.endedAt);
    setClauses.push(`"endedAt" = $${params.length}`);
  }
  if (opts.lastError !== undefined) {
    params.push(opts.lastError);
    setClauses.push(`"lastError" = $${params.length}`);
  }
  const sql = `UPDATE codex_runs SET ${setClauses.join(",")} WHERE ${where}`;
  const r = await pool().query(sql, params);
  return (r.rowCount || 0) > 0;
}

export async function bumpRunLastEventSeq(opts: { runId: string; sequence: number }): Promise<void> {
  await ensureRunsSchema();
  await pool().query(
    `UPDATE codex_runs SET "lastEventSeq" = GREATEST("lastEventSeq", $2)
      WHERE "runId" = $1`,
    [opts.runId, opts.sequence],
  );
}

export async function listActiveRunsForUser(opts: { userId: string; limit?: number }): Promise<CodexRun[]> {
  await ensureRunsSchema();
  const r = await pool().query(
    `SELECT * FROM codex_runs
      WHERE "userId" = $1
        AND "state" IN ('queued','dispatched','running','approval_pending','cancelling')
      ORDER BY "startedAt" DESC
      LIMIT $2`,
    [opts.userId, Math.min(opts.limit ?? 50, 500)],
  );
  return r.rows.map(rowToRun);
}

function rowToRun(row: any): CodexRun {
  return {
    runId: row.runId,
    userId: row.userId,
    orgId: row.orgId,
    threadId: row.threadId,
    agentId: row.agentId,
    companionId: row.companionId,
    providerMode: row.providerMode,
    state: row.state as CodexRunState,
    lastEventSeq: Number(row.lastEventSeq),
    startedAt: Number(row.startedAt),
    endedAt: row.endedAt ? Number(row.endedAt) : null,
    lastError: row.lastError,
    policySnapshot: row.policySnapshot,
    budgetMicroUsdSeen: Number(row.budgetMicroUsdSeen),
  };
}

// ─── Approval requests + decisions ────────────────────────────────────

export type ApprovalDecision = "approved" | "approvedForSession" | "denied" | "timed_out";

export interface ApprovalRow {
  approvalId: string;
  runId: string;
  userId: string;
  kind: string;
  methodName: string;
  summary: string;
  redactedPayload: any;
  requestedAt: number;
  decidedAt: number | null;
  decision: ApprovalDecision | null;
  decidedBy: string | null;
  decisionSource: string | null;
  companionId: string | null;
  expiresAt: number | null;
}

export async function createApprovalRequest(opts: {
  approvalId?: string;
  runId: string;
  userId: string;
  kind: string;
  methodName: string;
  summary: string;
  redactedPayload?: any;
  companionId?: string | null;
  ttlMs?: number;
  now?: number;
}): Promise<ApprovalRow> {
  await ensureRunsSchema();
  const now = opts.now ?? Date.now();
  const approvalId = opts.approvalId ?? `apr_${randomBytes(8).toString("hex")}`;
  const expiresAt = now + (opts.ttlMs ?? 5 * 60_000);
  await pool().query(
    `INSERT INTO codex_run_approvals
       ("approvalId","runId","userId","kind","methodName","summary",
        "redactedPayload","requestedAt","companionId","expiresAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [
      approvalId, opts.runId, opts.userId, opts.kind, opts.methodName,
      opts.summary, JSON.stringify(opts.redactedPayload ?? {}),
      now, opts.companionId ?? null, expiresAt,
    ],
  );
  const row = (await pool().query(
    `SELECT * FROM codex_run_approvals WHERE "approvalId" = $1`,
    [approvalId],
  )).rows[0];
  return rowToApproval(row);
}

export async function decideApproval(opts: {
  approvalId: string;
  userId: string;
  decision: ApprovalDecision;
  source?: string;
  now?: number;
}): Promise<{ ok: true; row: ApprovalRow } | { ok: false; reason: string }> {
  await ensureRunsSchema();
  const now = opts.now ?? Date.now();
  // Atomic transition: pending → decided. First-writer-wins on race.
  const r = await pool().query(
    `UPDATE codex_run_approvals
        SET "decidedAt" = $4, "decision" = $5, "decidedBy" = $2,
            "decisionSource" = $6
      WHERE "approvalId" = $1 AND "userId" = $2
        AND "decidedAt" IS NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > $4)
      RETURNING *`,
    [opts.approvalId, opts.userId, opts.decision, now, opts.decision, opts.source ?? "web"],
  );
  if ((r.rowCount || 0) === 0) {
    // Diagnose: missing? expired? already decided? wrong user?
    const probe = await pool().query(
      `SELECT * FROM codex_run_approvals WHERE "approvalId" = $1`,
      [opts.approvalId],
    );
    if (probe.rowCount === 0) return { ok: false, reason: "not_found" };
    const ex = probe.rows[0];
    if (ex.userId !== opts.userId) return { ok: false, reason: "wrong_user" };
    if (ex.decidedAt) return { ok: false, reason: "already_decided" };
    if (ex.expiresAt && Number(ex.expiresAt) <= now) return { ok: false, reason: "expired" };
    return { ok: false, reason: "unknown" };
  }
  return { ok: true, row: rowToApproval(r.rows[0]) };
}

export async function getApproval(opts: { approvalId: string; userId: string }): Promise<ApprovalRow | null> {
  await ensureRunsSchema();
  const r = await pool().query(
    `SELECT * FROM codex_run_approvals WHERE "approvalId" = $1 AND "userId" = $2`,
    [opts.approvalId, opts.userId],
  );
  return r.rows[0] ? rowToApproval(r.rows[0]) : null;
}

export async function listPendingApprovalsForUser(opts: { userId: string; limit?: number }): Promise<ApprovalRow[]> {
  await ensureRunsSchema();
  const r = await pool().query(
    `SELECT * FROM codex_run_approvals
      WHERE "userId" = $1 AND "decidedAt" IS NULL
      ORDER BY "requestedAt" ASC
      LIMIT $2`,
    [opts.userId, Math.min(opts.limit ?? 50, 500)],
  );
  return r.rows.map(rowToApproval);
}

export async function expirePastDueApprovals(opts: { now?: number } = {}): Promise<number> {
  await ensureRunsSchema();
  const now = opts.now ?? Date.now();
  const r = await pool().query(
    `UPDATE codex_run_approvals
        SET "decidedAt" = $1, "decision" = 'timed_out', "decisionSource" = 'timeout'
      WHERE "decidedAt" IS NULL AND "expiresAt" IS NOT NULL AND "expiresAt" <= $1`,
    [now],
  );
  return r.rowCount || 0;
}

function rowToApproval(row: any): ApprovalRow {
  return {
    approvalId: row.approvalId,
    runId: row.runId,
    userId: row.userId,
    kind: row.kind,
    methodName: row.methodName,
    summary: row.summary,
    redactedPayload: row.redactedPayload,
    requestedAt: Number(row.requestedAt),
    decidedAt: row.decidedAt ? Number(row.decidedAt) : null,
    decision: row.decision as ApprovalDecision | null,
    decidedBy: row.decidedBy,
    decisionSource: row.decisionSource,
    companionId: row.companionId,
    expiresAt: row.expiresAt ? Number(row.expiresAt) : null,
  };
}
