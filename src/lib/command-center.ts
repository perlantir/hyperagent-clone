// P32 — Command Center aggregation queries.
//
// Per-user operational snapshot: active runs, recent failure rate, hourly
// burn rate, schedule status, and miscellaneous health signals.
//
// Each function is independently usable so the API route can fetch them in
// parallel. All queries are scoped by userId — Command Center is a per-user
// dashboard, not a global admin view.

import { pool } from "./db";

// =================== ACTIVE RUNS ===================

export interface ActiveRun {
  runId: string;
  threadId: string | null;
  agentId: string | null;
  agentName: string | null;
  parentRunId: string | null;
  kind: string;
  startedAt: number;
  ageMs: number;
  spentCredits: number;
  budgetCapCredits: number | null;
  reservedCredits: number;
}

// In-flight runs: status='running'. Parent runs and child subagents both
// surface here so the operator can see depth at a glance.
export async function getActiveRuns(userId: string, limit = 50): Promise<ActiveRun[]> {
  const r = await pool().query(
    `SELECT
       tr.id, tr."threadId", tr."agentId", a.name AS agent_name,
       tr."parentRunId", tr.kind, tr."startedAt",
       COALESCE(tr."spentCredits", 0)::int AS spent,
       tr."budgetCapCredits"::int AS cap,
       COALESCE(tr."reservedCredits", 0)::int AS reserved
     FROM trace_runs tr
     LEFT JOIN agents a ON a.id = tr."agentId"
     WHERE tr."userId" = $1 AND tr.status = 'running'
     ORDER BY tr."startedAt" ASC
     LIMIT $2`,
    [userId, limit],
  );
  const now = Date.now();
  return r.rows.map((row: any) => ({
    runId: row.id,
    threadId: row.threadId,
    agentId: row.agentId,
    agentName: row.agent_name,
    parentRunId: row.parentRunId,
    kind: row.kind,
    startedAt: Number(row.startedAt),
    ageMs: now - Number(row.startedAt),
    spentCredits: Number(row.spent || 0),
    budgetCapCredits: row.cap !== null ? Number(row.cap) : null,
    reservedCredits: Number(row.reserved || 0),
  }));
}

// =================== HEALTH SNAPSHOT ===================

export interface HealthSnapshot {
  // Run outcomes over the trailing 24h
  last24hRuns: number;
  last24hFailures: number;
  last24hCancelled: number;
  last24hTimeout: number;
  failureRate: number;          // failures / total
  // Rough proxy for retry pressure: number of retry events in the last 24h
  last24hRetries: number;
  // Audit log dead-letter queue depth — non-zero means primary writes are
  // failing and we're falling back. Operators should investigate.
  auditDlqDepth: number;
  // Most recent budget_rolled_back event (subagent abort) — useful signal
  last24hRollbacks: number;
  // Cron pulse: heartbeat-style signal. We track the most recent
  // 'cron_tick' audit event timestamp; null = cron hasn't fired since boot.
  lastCronFireAt: number | null;
}

export async function getHealthSnapshot(userId: string): Promise<HealthSnapshot> {
  const since = Date.now() - 24 * 3600_000;

  // Run outcomes
  const runs = await pool().query(
    `SELECT status, COUNT(*)::int AS c
     FROM trace_runs
     WHERE "userId"=$1 AND "startedAt" >= $2
     GROUP BY status`,
    [userId, since],
  );
  let total = 0, failures = 0, cancelled = 0, timeout = 0;
  for (const row of runs.rows) {
    const c = Number(row.c);
    total += c;
    if (row.status === "failed") failures += c;
    if (row.status === "cancelled") cancelled += c;
    if (row.status === "timeout") timeout += c;
  }

  // Trace events: retries + budget rollbacks
  const events = await pool().query(
    `SELECT "eventType", COUNT(*)::int AS c
     FROM trace_events e
     WHERE "ts" >= $2
       AND EXISTS (SELECT 1 FROM trace_runs r WHERE r.id = e."runId" AND r."userId" = $1)
       AND "eventType" IN ('retry','budget_rolled_back')
     GROUP BY "eventType"`,
    [userId, since],
  );
  let retries = 0, rollbacks = 0;
  for (const row of events.rows) {
    if (row.eventType === "retry") retries = Number(row.c);
    if (row.eventType === "budget_rolled_back") rollbacks = Number(row.c);
  }

  // Audit DLQ depth — global, not per-user. Operators see total system
  // health here even though the rest of the page is per-user.
  let auditDlqDepth = 0;
  try {
    const dlq = await pool().query(`SELECT COUNT(*)::int AS c FROM audit_log_dlq WHERE replayed=false`);
    auditDlqDepth = Number(dlq.rows[0]?.c || 0);
  } catch { /* table may not exist yet */ }

  // Last cron pulse — pull the most recent 'cron.tick' audit event.
  let lastCronFireAt: number | null = null;
  try {
    const cron = await pool().query(
      `SELECT MAX("ts") AS t FROM audit_log WHERE action = 'cron.tick'`,
    );
    lastCronFireAt = cron.rows[0]?.t ? Number(cron.rows[0].t) : null;
  } catch { /* fine */ }

  return {
    last24hRuns: total,
    last24hFailures: failures,
    last24hCancelled: cancelled,
    last24hTimeout: timeout,
    failureRate: total > 0 ? failures / total : 0,
    last24hRetries: retries,
    auditDlqDepth,
    last24hRollbacks: rollbacks,
    lastCronFireAt,
  };
}

// =================== BURN RATE ===================

export interface BurnRatePoint {
  hour: string;       // YYYY-MM-DD HH:00 UTC
  costCredits: number;
  runs: number;
}

// Per-hour cost for the last N hours. Used to render a sparkline + detect
// burn-rate anomalies. 24h default keeps the chart dense without overflow.
export async function getBurnRate(userId: string, hours = 24): Promise<BurnRatePoint[]> {
  const since = Date.now() - hours * 3600_000;
  const r = await pool().query(
    `SELECT
       to_char(date_trunc('hour', to_timestamp("startedAt" / 1000.0)), 'YYYY-MM-DD HH24:00') AS hour,
       COUNT(*)::int                              AS runs,
       COALESCE(SUM("totalCostCredits"), 0)::int   AS cost
     FROM trace_runs
     WHERE "userId" = $1 AND "startedAt" >= $2
     GROUP BY hour
     ORDER BY hour ASC`,
    [userId, since],
  );
  // Backfill empty hours so the chart spans the full window without gaps.
  const points: BurnRatePoint[] = [];
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const byHour: Record<string, { runs: number; cost: number }> = {};
  for (const row of r.rows) byHour[row.hour] = { runs: Number(row.runs), cost: Number(row.cost) };
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600_000);
    const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`;
    const p = byHour[key] || { runs: 0, cost: 0 };
    points.push({ hour: key, runs: p.runs, costCredits: p.cost });
  }
  return points;
}
function pad(n: number) { return String(n).padStart(2, "0"); }

// =================== SCHEDULE STATUS ===================

export interface ScheduleStatusEntry {
  scheduleId: string;
  agentId: string;
  agentName: string | null;
  name: string;
  intervalMinutes: number;
  active: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  recentFailures: number;     // last 10 runs
  recentRuns: number;         // last 10 runs (total)
}

// Schedule fleet view. Pulls each schedule + its last/next fire + recent
// success ratio. Agents aren't joined on a single SQL because schedules
// reference agents by id without a NOT NULL FK.
export async function getScheduleStatus(userId: string): Promise<ScheduleStatusEntry[]> {
  const sched = await pool().query(
    `SELECT s.id, s."agentId", a.name AS agent_name, s.name, s."intervalMinutes",
            s.active, s."lastRunAt"
     FROM schedules s
     LEFT JOIN agents a ON a.id = s."agentId"
     WHERE s."userId" = $1
     ORDER BY s."createdAt" DESC`,
    [userId],
  );
  const out: ScheduleStatusEntry[] = [];
  for (const row of sched.rows) {
    // Recent runs: last 10 from runs table.
    const runs = await pool().query(
      `SELECT status FROM runs WHERE "scheduleId" = $1
       ORDER BY "startedAt" DESC LIMIT 10`,
      [row.id],
    );
    const recentFailures = runs.rows.filter((r: any) => r.status === "error").length;
    const recentRuns = runs.rows.length;
    const nextRunAt = row.lastRunAt && row.active
      ? Number(row.lastRunAt) + Number(row.intervalMinutes) * 60_000
      : null;
    out.push({
      scheduleId: row.id,
      agentId: row.agentId,
      agentName: row.agent_name,
      name: row.name,
      intervalMinutes: Number(row.intervalMinutes),
      active: Number(row.active) === 1,
      lastRunAt: row.lastRunAt ? Number(row.lastRunAt) : null,
      nextRunAt,
      recentFailures,
      recentRuns,
    });
  }
  return out;
}

// =================== CANCEL ACTIVE RUN ===================

// Cooperative cancel: marks the run as 'cancelled'. The chat loop checks
// trace_runs.status between iterations and exits early when it sees this
// state. Long-running LLM streams won't be interrupted mid-token, but the
// next tool/iteration boundary will short-circuit.
//
// Returns false if the run wasn't found, wasn't owned by the user, or
// wasn't in 'running' state.
export async function cancelActiveRun(runId: string, userId: string): Promise<boolean> {
  const r = await pool().query(
    `UPDATE trace_runs
     SET status = 'cancelled', "endedAt" = $3
     WHERE id = $1 AND "userId" = $2 AND status = 'running'`,
    [runId, userId, Date.now()],
  );
  return (r.rowCount || 0) > 0;
}

// Used by the chat loop: returns true if the run has been marked for
// cancellation. Cheap single-row read; called between iterations.
export async function isRunCancelled(runId: string): Promise<boolean> {
  const r = await pool().query(
    `SELECT status FROM trace_runs WHERE id=$1`,
    [runId],
  );
  return r.rows[0]?.status === "cancelled";
}
