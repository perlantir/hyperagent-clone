// P33a — Audit log with dead-letter fallback.
//
// Append-only record of security-relevant actions. Two-tier storage:
//
//   1. Primary: audit_log table — indexed by (userId, ts), (action, ts),
//      (resource, ts), AND a GIN index on metadata for ad-hoc JSONB queries
//      ("find rows where metadata.creditAmount > 1000").
//
//   2. Dead-letter: audit_log_dlq table — written when the primary INSERT
//      fails (DB connection blip, schema issue, etc.). Operators can replay
//      DLQ rows back into audit_log later.
//
//   3. Last-ditch: structured stderr JSON line so the event survives even
//      if both tables are down. Vercel log retention captures these for
//      retroactive forensics.

import { pool } from "./db";

export type AuditAction =
  | "auth.login" | "auth.signup" | "auth.logout" | "auth.failed"
  | "secret.set" | "secret.delete" | "secret.read"
  | "memory.write" | "memory.delete" | "memory.read_pii"
  | "agent.create" | "agent.update" | "agent.delete"
  | "schedule.create" | "schedule.update" | "schedule.delete"
  | "billing.topup" | "billing.refund" | "billing.failed"
  | "api_key.create" | "api_key.revoke" | "api_key.used"
  | "webhook.received" | "webhook.rejected"
  | "rate_limit.blocked"
  | "permission.denied"
  | "thread.delete" | "agent_run.cancelled"
  | "cron.tick";

export type AuditResult = "success" | "failure" | "denied";

export interface AuditInput {
  userId: string | null;
  action: AuditAction;
  resource?: string | null;
  result: AuditResult;
  metadata?: Record<string, any>;
  ip?: string | null;
  userAgent?: string | null;
}

let _initialized = false;
let _dlqCount = 0;        // in-process counter for monitoring DLQ writes
let _stderrCount = 0;     // in-process counter for monitoring last-ditch writes

// Exported so read-only callers (audit query endpoint) can ensure the
// table exists before running SELECT on a fresh deployment.
export async function ensureAuditSchema() { return ensureSchema(); }

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      "userId" TEXT,
      action TEXT NOT NULL,
      resource TEXT,
      result TEXT NOT NULL,
      metadata JSONB,
      ip TEXT,
      "userAgent" TEXT,
      "ts" BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user_ts ON audit_log("userId", "ts" DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_log(action, "ts" DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_resource_ts ON audit_log(resource, "ts" DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_metadata_gin ON audit_log USING gin(metadata);

    CREATE TABLE IF NOT EXISTS audit_log_dlq (
      id BIGSERIAL PRIMARY KEY,
      "originalEvent" JSONB NOT NULL,
      "errorMessage" TEXT,
      "ts" BIGINT NOT NULL,
      replayed BOOLEAN NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS idx_audit_dlq_ts ON audit_log_dlq("ts" DESC);
  `);
  _initialized = true;
}

// Two-tier write: primary → DLQ → stderr. Each fallback level catches
// failures of the level above. User-facing operation never blocks on audit.
export async function audit(input: AuditInput): Promise<void> {
  let primaryError: Error | null = null;

  try {
    await ensureSchema();
    await pool().query(
      `INSERT INTO audit_log ("userId", action, resource, result, metadata, ip, "userAgent", "ts")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.userId, input.action, input.resource || null, input.result,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.ip || null, input.userAgent || null, Date.now(),
      ],
    );
    return;
  } catch (err) {
    primaryError = err as Error;
  }

  // Fallback 1: dead-letter table
  try {
    await pool().query(
      `INSERT INTO audit_log_dlq ("originalEvent", "errorMessage", "ts")
       VALUES ($1, $2, $3)`,
      [
        JSON.stringify({ ...input, attemptedAt: Date.now() }),
        primaryError.message?.slice(0, 500) || String(primaryError),
        Date.now(),
      ],
    );
    _dlqCount++;
    console.error(JSON.stringify({
      level: "error", source: "audit", path: "dlq",
      action: input.action, userId: input.userId,
      primaryError: primaryError.message,
      dlqWritesThisInstance: _dlqCount,
    }));
    return;
  } catch (dlqError) {
    // Fallback 2: last-ditch structured stderr. Vercel log retention
    // captures this for retroactive forensics. Manual replay possible
    // by parsing logs.
    _stderrCount++;
    console.error(JSON.stringify({
      level: "critical", source: "audit", path: "stderr_fallback",
      event: input,
      primaryError: primaryError.message,
      dlqError: (dlqError as Error)?.message,
      stderrWritesThisInstance: _stderrCount,
      ts: Date.now(),
    }));
  }
}

export function auditFromRequest(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || req.headers.get("x-real-ip")
        || null,
    userAgent: req.headers.get("user-agent") || null,
  };
}

// Read endpoints (used by /api/audit and admin tools later)
export async function listAuditForUser(userId: string, limit = 100): Promise<any[]> {
  await ensureSchema();
  const r = await pool().query(
    `SELECT * FROM audit_log WHERE "userId"=$1 ORDER BY "ts" DESC LIMIT $2`,
    [userId, limit],
  );
  return r.rows;
}

export async function listAuditByAction(action: AuditAction, limit = 100): Promise<any[]> {
  await ensureSchema();
  const r = await pool().query(
    `SELECT * FROM audit_log WHERE action=$1 ORDER BY "ts" DESC LIMIT $2`,
    [action, limit],
  );
  return r.rows;
}

// DLQ inspection — used by the cron sweeper or admin tools to find rows
// that need replaying.
export async function listUnreplayedDlq(limit = 100): Promise<any[]> {
  await ensureSchema();
  const r = await pool().query(
    `SELECT * FROM audit_log_dlq WHERE replayed=false ORDER BY "ts" ASC LIMIT $1`,
    [limit],
  );
  return r.rows;
}

// Replay DLQ rows back into the primary audit_log. Returns the count replayed.
// Idempotent: marks each row as replayed=true after success.
export async function replayDlq(limit = 100): Promise<{ replayed: number; failed: number }> {
  const rows = await listUnreplayedDlq(limit);
  let replayed = 0, failed = 0;
  for (const row of rows) {
    try {
      const e = row.originalEvent;
      await pool().query(
        `INSERT INTO audit_log ("userId", action, resource, result, metadata, ip, "userAgent", "ts")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          e.userId, e.action, e.resource || null, e.result,
          e.metadata ? JSON.stringify(e.metadata) : null,
          e.ip || null, e.userAgent || null, e.attemptedAt || Date.now(),
        ],
      );
      await pool().query(`UPDATE audit_log_dlq SET replayed=true WHERE id=$1`, [row.id]);
      replayed++;
    } catch {
      failed++;
    }
  }
  return { replayed, failed };
}

// Counters for monitoring. Query these from /api/health or an admin dashboard.
export function getAuditStats() {
  return { dlqWritesThisInstance: _dlqCount, stderrWritesThisInstance: _stderrCount };
}
