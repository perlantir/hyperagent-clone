// P27b — Cost aggregation queries.
//
// Reads from trace_runs (the canonical source of per-run cost data) plus
// credit_transactions (top-ups + manual adjustments) to render the UI's
// cost surfaces.
//
// All queries are scoped by userId. Time ranges use ISO ms epochs so the
// frontend can pass `from`/`to` directly without parsing dates.

import { pool } from "./db";

export interface CostRange {
  from?: number;       // epoch ms inclusive
  to?: number;         // epoch ms exclusive
}

export interface PerAgentCost {
  agentId: string | null;
  agentName: string | null;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costCredits: number;
  avgLatencyMs: number | null;
}

export interface PerDayCost {
  day: string;          // YYYY-MM-DD UTC
  runs: number;
  costCredits: number;
}

export interface UserCostSummary {
  totalRuns: number;
  totalCostCredits: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  cacheHitRate: number;        // cacheReadTokens / (cacheReadTokens + inputTokens)
  avgRunCostCredits: number;
  avgLatencyMs: number | null;
  windowFrom: number | null;
  windowTo: number | null;
}

function rangeClause(range: CostRange): { clause: string; params: any[] } {
  const params: any[] = [];
  let clause = "";
  if (range.from) {
    params.push(range.from);
    clause += ` AND "startedAt" >= $${params.length + 1}`; // +1 because userId is $1
  }
  if (range.to) {
    params.push(range.to);
    clause += ` AND "startedAt" < $${params.length + 1}`;
  }
  return { clause, params };
}

export async function userSummary(userId: string, range: CostRange = {}): Promise<UserCostSummary> {
  const r = rangeClause(range);
  const result = await pool().query(`
    SELECT
      COUNT(*)::int                                AS runs,
      COALESCE(SUM("totalCostCredits"), 0)::int    AS cost,
      COALESCE(SUM("totalInputTokens"), 0)::int    AS in_tok,
      COALESCE(SUM("totalOutputTokens"), 0)::int   AS out_tok,
      COALESCE(SUM("totalCacheReadTokens"), 0)::int AS cache_read,
      COALESCE(SUM("totalCacheWriteTokens"), 0)::int AS cache_create,
      AVG(NULLIF("endedAt" - "startedAt", 0))      AS avg_latency
    FROM trace_runs
    WHERE "userId" = $1 AND status = 'succeeded' ${r.clause}
  `, [userId, ...r.params]);
  const row = result.rows[0] || {};
  const inTok = Number(row.in_tok || 0);
  const cacheRead = Number(row.cache_read || 0);
  const cacheTotal = inTok + cacheRead;
  const runs = Number(row.runs || 0);
  const cost = Number(row.cost || 0);

  return {
    totalRuns: runs,
    totalCostCredits: cost,
    totalInputTokens: inTok,
    totalOutputTokens: Number(row.out_tok || 0),
    totalCacheReadTokens: cacheRead,
    totalCacheCreateTokens: Number(row.cache_create || 0),
    cacheHitRate: cacheTotal > 0 ? cacheRead / cacheTotal : 0,
    avgRunCostCredits: runs > 0 ? Math.round(cost / runs) : 0,
    avgLatencyMs: row.avg_latency ? Math.round(Number(row.avg_latency)) : null,
    windowFrom: range.from || null,
    windowTo: range.to || null,
  };
}

export async function perAgentCosts(userId: string, range: CostRange = {}, limit = 20): Promise<PerAgentCost[]> {
  const r = rangeClause(range);
  const result = await pool().query(`
    SELECT
      tr."agentId",
      a.name                                       AS agent_name,
      COUNT(*)::int                                AS runs,
      COALESCE(SUM(tr."totalInputTokens"), 0)::int  AS in_tok,
      COALESCE(SUM(tr."totalOutputTokens"), 0)::int AS out_tok,
      COALESCE(SUM(tr."totalCacheReadTokens"), 0)::int   AS cache_read,
      COALESCE(SUM(tr."totalCacheWriteTokens"), 0)::int  AS cache_create,
      COALESCE(SUM(tr."totalCostCredits"), 0)::int  AS cost,
      AVG(NULLIF(tr."endedAt" - tr."startedAt", 0)) AS avg_latency
    FROM trace_runs tr
    LEFT JOIN agents a ON a.id = tr."agentId"
    WHERE tr."userId" = $1 AND tr.status = 'succeeded' ${r.clause}
    GROUP BY tr."agentId", a.name
    ORDER BY cost DESC NULLS LAST
    LIMIT ${limit}
  `, [userId, ...r.params]);
  return result.rows.map((row: any) => ({
    agentId: row.agentId,
    agentName: row.agent_name,
    runs: Number(row.runs || 0),
    inputTokens: Number(row.in_tok || 0),
    outputTokens: Number(row.out_tok || 0),
    cacheReadTokens: Number(row.cache_read || 0),
    cacheCreateTokens: Number(row.cache_create || 0),
    costCredits: Number(row.cost || 0),
    avgLatencyMs: row.avg_latency ? Math.round(Number(row.avg_latency)) : null,
  }));
}

export async function perDayCosts(userId: string, range: CostRange = {}, days = 30): Promise<PerDayCost[]> {
  const r = rangeClause(range);
  const result = await pool().query(`
    SELECT
      to_char(to_timestamp("startedAt" / 1000.0), 'YYYY-MM-DD') AS day,
      COUNT(*)::int                                              AS runs,
      COALESCE(SUM("totalCostCredits"), 0)::int                  AS cost
    FROM trace_runs
    WHERE "userId" = $1 AND status = 'succeeded' ${r.clause}
    GROUP BY day
    ORDER BY day DESC
    LIMIT ${days}
  `, [userId, ...r.params]);
  return result.rows.map((row: any) => ({
    day: row.day,
    runs: Number(row.runs || 0),
    costCredits: Number(row.cost || 0),
  })).reverse(); // chronological asc for chart rendering
}

export interface RecentRun {
  runId: string;
  threadId: string | null;
  agentId: string | null;
  agentName: string | null;
  kind: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  costCredits: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export async function recentRuns(userId: string, limit = 20): Promise<RecentRun[]> {
  const result = await pool().query(`
    SELECT
      tr.id, tr."threadId", tr."agentId", a.name AS agent_name,
      tr.kind, tr.status, tr."startedAt", tr."endedAt",
      COALESCE(tr."totalCostCredits", 0)::int     AS cost,
      COALESCE(tr."totalInputTokens", 0)::int     AS in_tok,
      COALESCE(tr."totalOutputTokens", 0)::int    AS out_tok,
      COALESCE(tr."totalCacheReadTokens", 0)::int AS cache_read
    FROM trace_runs tr
    LEFT JOIN agents a ON a.id = tr."agentId"
    WHERE tr."userId" = $1
    ORDER BY tr."startedAt" DESC
    LIMIT $2
  `, [userId, limit]);
  return result.rows.map((row: any) => ({
    runId: row.id,
    threadId: row.threadId,
    agentId: row.agentId,
    agentName: row.agent_name,
    kind: row.kind,
    status: row.status,
    startedAt: Number(row.startedAt),
    endedAt: row.endedAt ? Number(row.endedAt) : null,
    costCredits: Number(row.cost || 0),
    inputTokens: Number(row.in_tok || 0),
    outputTokens: Number(row.out_tok || 0),
    cacheReadTokens: Number(row.cache_read || 0),
  }));
}
