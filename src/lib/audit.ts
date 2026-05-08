// P33a — Audit log.
//
// Append-only record of security-relevant actions. Distinct from trace_events
// (which is for debugging individual runs); audit is for compliance and
// security review: who did what, when, to what resource, with what result.
//
// Lookup patterns we need:
//   - "who topped up Stripe in the last 30 days?"
//   - "show all secret.set events for user X"
//   - "all rate_limit.blocked events in the last hour"
//   - "all permission.denied events" (potential probe attempts)
//
// Indexed on (userId, ts), (action, ts), and (resource, ts) for these queries.

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
  | "thread.delete" | "agent_run.cancelled";

export type AuditResult = "success" | "failure" | "denied";

export interface AuditInput {
  userId: string | null;        // null for anonymous probes
  action: AuditAction;
  resource?: string | null;     // e.g. "thread:abc", "agent:xyz", "stripe_event:evt_123"
  result: AuditResult;
  metadata?: Record<string, any>;
  ip?: string | null;
  userAgent?: string | null;
}

let _initialized = false;

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
  `);
  _initialized = true;
}

export async function audit(input: AuditInput): Promise<void> {
  // Audit failures must never break the user-facing operation. Log + swallow.
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
  } catch (err) {
    console.error("[audit]", err);
  }
}

// Convenience helper that pulls IP + user agent from a Request.
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
