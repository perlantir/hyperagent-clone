// P66b — Codex audit log.
//
// Smallest practical migration from the P66a §7 schema sketch. One
// table: codex_audit_log. Used today by the local-direct lane to
// record run lifecycle events; will be reused by P66c/P66d for
// companion lane lifecycle, by P66f for security events, and by the
// admin command-center for "what did this user run, where, and when".
//
// Design choices:
//
//   - User-scoped + org-scoped. Every row carries userId; orgId is
//     populated when known. Callers should ALWAYS pass orgId when the
//     user object has one — admin queries depend on it.
//
//   - Cheap to write. Single INSERT per emit; no JSONB indexing
//     beyond the primary index. Severity enum routed at write time so
//     we can aggregate "errors/security in the last hour" cheaply.
//
//   - No raw secrets. Callers pass `details: any`; the helper redacts
//     the same way the event-mirror does (defense-in-depth even though
//     the chat-bridge already redacts).
//
//   - TTL pruner. `pruneOldAuditLog(olderThanMs)` deletes rows older
//     than the threshold. Run from a cron job; for the alpha we
//     advise 1 year for "info", 90d for "warn"/"error", retain
//     "security" indefinitely.
//
//   - Rollback-safe. The migration is idempotent (`CREATE TABLE IF
//     NOT EXISTS`); rolling back is a `DROP TABLE` — no foreign-key
//     fan-out because we keep `userId` as a plain TEXT column with
//     no FK constraint to avoid a hot path on user deletion.
//     (Cleanup of audit rows on user-delete is best-effort cron, not
//     cascading FK; this is intentional — audit logs survive user
//     deletion until policy says otherwise.)

import { pool } from "../db";
import { redactJson } from "./redact";

let _initialized = false;

export async function ensureAuditLogSchema(): Promise<void> {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS codex_audit_log (
      "id" BIGSERIAL PRIMARY KEY,
      "userId" TEXT,
      "orgId" TEXT,
      "companionId" TEXT,
      "runId" TEXT,
      "providerMode" TEXT,
      "event" TEXT NOT NULL,
      "severity" TEXT NOT NULL,
      "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "at" BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "codex_audit_log_userId_at_idx"
      ON codex_audit_log("userId","at" DESC);
    CREATE INDEX IF NOT EXISTS "codex_audit_log_orgId_at_idx"
      ON codex_audit_log("orgId","at" DESC);
    CREATE INDEX IF NOT EXISTS "codex_audit_log_runId_at_idx"
      ON codex_audit_log("runId","at" DESC);
    -- Severity-only index so admin "show me security events" runs in
    -- bounded time even on a large audit table.
    CREATE INDEX IF NOT EXISTS "codex_audit_log_severity_at_idx"
      ON codex_audit_log("severity","at" DESC)
      WHERE "severity" IN ('error','security');
  `);
  _initialized = true;
}

// ─── Event taxonomy ────────────────────────────────────────────────
//
// Names use slash-separated paths so a future query can filter by
// prefix (e.g. all "run/*" events for a user). Keep the list short
// and add new ones explicitly — open enums make audit queries fragile.

export type CodexAuditEvent =
  | "run/created"
  | "run/dispatched"
  | "run/started"
  | "run/completed"
  | "run/failed"
  | "run/cancelled"
  | "approval/requested"
  | "approval/decided"
  | "companion/connected"
  | "companion/disconnected"
  | "companion/revoked"
  | "pair/started"
  | "pair/claimed"
  | "pair/revoked"
  | "policy/violation"
  | "csrf/blocked"
  | "origin/blocked"
  | "ticket/invalid"
  | "local/runtime/missing"
  | "local/codex/missing"
  | "local/auth/required"
  | "local/auth/refreshed";

export type CodexAuditSeverity = "info" | "warn" | "error" | "security";

export interface AuditLogInput {
  userId?: string | null;
  orgId?: string | null;
  companionId?: string | null;
  runId?: string | null;
  providerMode?: string | null;
  event: CodexAuditEvent;
  severity: CodexAuditSeverity;
  details?: any;
  now?: number;
}

// ─── Public API ────────────────────────────────────────────────────

export async function emitAuditLog(input: AuditLogInput): Promise<void> {
  // Best-effort. Swallow DB errors so an audit-log outage never
  // breaks a user-facing chat turn. We DO surface to console so a
  // dev sees the issue.
  try {
    await ensureAuditLogSchema();
    const now = input.now ?? Date.now();
    const safe = redactJson(input.details ?? {});
    await pool().query(
      `INSERT INTO codex_audit_log
         ("userId","orgId","companionId","runId","providerMode","event","severity","details","at")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        input.userId ?? null,
        input.orgId ?? null,
        input.companionId ?? null,
        input.runId ?? null,
        input.providerMode ?? null,
        input.event,
        input.severity,
        JSON.stringify(safe),
        now,
      ],
    );
  } catch (e: any) {
    // Don't await; don't let this crash the caller.
    // eslint-disable-next-line no-console
    console.warn(`[codex-audit] failed to write ${input.event}:`, e?.message || e);
  }
}

export interface ListAuditLogOptions {
  userId?: string;
  orgId?: string;
  runId?: string;
  severity?: CodexAuditSeverity;
  sinceMs?: number;
  beforeMs?: number;
  limit?: number;
}

export async function listAuditLog(opts: ListAuditLogOptions): Promise<Array<{
  id: number;
  userId: string | null;
  orgId: string | null;
  companionId: string | null;
  runId: string | null;
  providerMode: string | null;
  event: CodexAuditEvent;
  severity: CodexAuditSeverity;
  details: any;
  at: number;
}>> {
  await ensureAuditLogSchema();
  const where: string[] = [];
  const args: any[] = [];
  if (opts.userId) { args.push(opts.userId); where.push(`"userId" = $${args.length}`); }
  if (opts.orgId) { args.push(opts.orgId); where.push(`"orgId" = $${args.length}`); }
  if (opts.runId) { args.push(opts.runId); where.push(`"runId" = $${args.length}`); }
  if (opts.severity) { args.push(opts.severity); where.push(`"severity" = $${args.length}`); }
  if (opts.sinceMs !== undefined) { args.push(opts.sinceMs); where.push(`"at" >= $${args.length}`); }
  if (opts.beforeMs !== undefined) { args.push(opts.beforeMs); where.push(`"at" < $${args.length}`); }
  args.push(Math.min(opts.limit ?? 200, 5000));
  const limitArg = `$${args.length}`;
  const sql = `SELECT "id","userId","orgId","companionId","runId","providerMode","event","severity","details","at"
                 FROM codex_audit_log
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY "at" DESC, "id" DESC
               LIMIT ${limitArg}`;
  const r = await pool().query(sql, args);
  return r.rows.map((row: any) => ({
    id: Number(row.id),
    userId: row.userId,
    orgId: row.orgId,
    companionId: row.companionId,
    runId: row.runId,
    providerMode: row.providerMode,
    event: row.event,
    severity: row.severity,
    details: row.details,
    at: Number(row.at),
  }));
}

// TTL pruner. Returns rows deleted. Severity-aware:
//   - "info"/"warn" rows older than `infoOlderThanMs` are deleted.
//   - "error" rows older than `errorOlderThanMs` are deleted.
//   - "security" rows are NEVER deleted by this helper.
export async function pruneOldAuditLog(opts: {
  infoOlderThanMs?: number;
  errorOlderThanMs?: number;
  now?: number;
} = {}): Promise<{ infoDeleted: number; errorDeleted: number }> {
  await ensureAuditLogSchema();
  const now = opts.now ?? Date.now();
  const infoCutoff = now - (opts.infoOlderThanMs ?? 365 * 24 * 3600_000); // default 1 year
  const errorCutoff = now - (opts.errorOlderThanMs ?? 90 * 24 * 3600_000); // default 90 days
  const infoDel = await pool().query(
    `DELETE FROM codex_audit_log WHERE "severity" IN ('info','warn') AND "at" < $1`,
    [infoCutoff],
  );
  const errDel = await pool().query(
    `DELETE FROM codex_audit_log WHERE "severity" = 'error' AND "at" < $1`,
    [errorCutoff],
  );
  return {
    infoDeleted: infoDel.rowCount || 0,
    errorDeleted: errDel.rowCount || 0,
  };
}
