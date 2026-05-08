// P28a — Trace Skeleton.
//
// Append-only event log for every meaningful operation in a run. One "run" =
// one chat turn (or scheduled invocation, or v1 API call, or subagent
// dispatch when P24 lands). Each run accumulates events: prompts compiled,
// LLM calls made, tools called, memories read/written, cache hits/misses,
// retries, errors. Flushed in batches at run end so we don't add user-facing
// latency on the hot path.
//
// Foundation for P28b (replay/fork/versioning UI), P26 (rubric judge reads
// traces), P27b (cost surface aggregates from traces), P32 (command center
// dashboards aggregate from traces). Every later phase reads from this.
//
// Design notes:
//   - Append-only — never UPDATE/DELETE events. Schema migration only.
//   - Buffered — emit() is sync to memory; one batched flush per run.
//   - Lossy on crash — if the lambda dies mid-turn we lose unsynced events.
//     Acceptable: the user message already streamed back via SSE. Traces are
//     for retrospective debugging, not user-facing correctness.
//   - JSONB payload — query-able later via Postgres JSON operators. Heavy
//     analytics will eventually move to ClickHouse, but Postgres is fine for v0.

import crypto from "node:crypto";
import { pool } from "./db";
import { redactSecretsDeep } from "./security";

export type EventType =
  | "prompt_compiled"        // compiler ran; payload: { fingerprint, totalTokens, blockCount, cacheBoundaries, included, dropped }
  | "llm_call"               // anthropic/openai/gemini call; payload: { model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, durationMs }
  | "tool_call"              // model issued a tool_use block; payload: { name, args }
  | "tool_result"            // tool finished; payload: { name, result, durationMs, success }
  | "memory_read"            // retrieved memories; payload: { count, kinds: { pinned: N, contextual: M } }
  | "memory_write"           // wrote a memory; payload: { id, content, scope }  (P25)
  | "subagent_dispatch"      // P24
  | "subagent_complete"      // P24
  | "retry"                  // tool/llm retry; payload: { reason, attemptNum }
  | "cache_hit"              // anthropic prompt cache hit; payload: { tokens }
  | "cache_miss"             // payload: { reason }
  | "section_drop"           // prompt compiler dropped a segment; payload: { kind, reason }
  | "budget_reserved"        // P27a
  | "budget_committed"
  | "budget_rolled_back"
  | "error";                 // anything caught; payload: { message, stack, source }

export type RunKind = "chat_turn" | "scheduled" | "v1_api" | "subagent" | "slack_inbound";
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled" | "timeout";

export interface StartRunInput {
  userId: string;
  threadId?: string | null;
  messageId?: string | null;
  agentId?: string | null;
  parentRunId?: string | null;
  kind: RunKind;
  metadata?: Record<string, any>;
}

export interface EndRunInput {
  status: RunStatus;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  totalCostCredits?: number;
  errorMessage?: string;
  metadata?: Record<string, any>;
}

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS trace_runs (
      id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES users(id),
      "threadId" TEXT,
      "messageId" TEXT,
      "agentId" TEXT,
      "parentRunId" TEXT REFERENCES trace_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      "startedAt" BIGINT NOT NULL,
      "endedAt" BIGINT,
      "totalInputTokens" INTEGER,
      "totalOutputTokens" INTEGER,
      "totalCacheReadTokens" INTEGER,
      "totalCacheWriteTokens" INTEGER,
      "totalCostCredits" INTEGER,
      "errorMessage" TEXT,
      metadata JSONB
    );
    CREATE TABLE IF NOT EXISTS trace_events (
      id BIGSERIAL PRIMARY KEY,
      "runId" TEXT NOT NULL REFERENCES trace_runs(id) ON DELETE CASCADE,
      "ts" BIGINT NOT NULL,
      "eventType" TEXT NOT NULL,
      payload JSONB NOT NULL,
      "durationMs" INTEGER,
      "parentEventId" BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_trace_events_run ON trace_events("runId", "ts");
    CREATE INDEX IF NOT EXISTS idx_trace_runs_user ON trace_runs("userId", "startedAt" DESC);
    CREATE INDEX IF NOT EXISTS idx_trace_runs_parent ON trace_runs("parentRunId");
    CREATE INDEX IF NOT EXISTS idx_trace_runs_thread ON trace_runs("threadId", "startedAt" DESC);
  `);
  _initialized = true;
}

export async function startRun(input: StartRunInput): Promise<string> {
  await ensureSchema();
  const id = "run_" + crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  await pool().query(
    `INSERT INTO trace_runs (id, "userId", "threadId", "messageId", "agentId", "parentRunId", kind, status, "startedAt", metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9)`,
    [id, input.userId, input.threadId || null, input.messageId || null, input.agentId || null,
     input.parentRunId || null, input.kind, now, input.metadata || {}],
  );
  return id;
}

export async function endRun(runId: string, input: EndRunInput): Promise<void> {
  await pool().query(
    `UPDATE trace_runs
     SET status=$2, "endedAt"=$3,
         "totalInputTokens"=$4, "totalOutputTokens"=$5,
         "totalCacheReadTokens"=$6, "totalCacheWriteTokens"=$7,
         "totalCostCredits"=$8, "errorMessage"=$9,
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($10::jsonb, '{}'::jsonb)
     WHERE id=$1`,
    [
      runId, input.status, Date.now(),
      input.totalInputTokens || null, input.totalOutputTokens || null,
      input.totalCacheReadTokens || null, input.totalCacheWriteTokens || null,
      input.totalCostCredits || null, input.errorMessage || null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}

// Buffered event emitter. Caller emits synchronously to memory; flush() is
// the only DB-touching operation. Designed for per-run scope: instantiate at
// run start, flush once at run end.
export class TraceEmitter {
  private buffer: Array<{
    runId: string;
    ts: number;
    eventType: EventType;
    payload: any;
    durationMs?: number;
    parentEventId?: number;
  }> = [];
  private flushed = false;

  constructor(public readonly runId: string) {}

  emit(eventType: EventType, payload: any, opts: { durationMs?: number; parentEventId?: number } = {}) {
    if (this.flushed) {
      // Should never happen — but if it does, log loudly rather than silently lose events
      console.warn("[trace] emit after flush", { runId: this.runId, eventType });
    }
    this.buffer.push({
      runId: this.runId,
      ts: Date.now(),
      eventType,
      payload: payload || {},
      durationMs: opts.durationMs,
      parentEventId: opts.parentEventId,
    });
  }

  // Adapter for prompt-compiler's emitter signature: (event) => void
  // The compiler emits events with .type which we map to our EventType.
  asCompilerEmitter() {
    return (event: any) => {
      const type = event.type as EventType;
      // Translate "prompt_compiled" + "prompt_overbudget" + per-segment events
      if (type === "prompt_compiled") {
        this.emit("prompt_compiled", event);
        // If any segments were dropped, also emit per-segment events for queryability
        for (const d of event.dropped || []) {
          this.emit("section_drop", { kind: d.kind, reason: d.reason });
        }
      } else if (type === "section_drop") {
        this.emit("section_drop", event);
      } else if (event.type === "prompt_overbudget") {
        this.emit("error", { source: "prompt_compiler", reason: "overbudget", ...event });
      }
    };
  }

  // Bulk-INSERT all buffered events. Idempotent — calling twice is a no-op
  // after the first call.
  async flush(): Promise<{ flushed: number }> {
    if (this.flushed || this.buffer.length === 0) {
      this.flushed = true;
      return { flushed: 0 };
    }
    this.flushed = true;
    const events = this.buffer;
    this.buffer = [];
    // Build a single bulk INSERT for efficiency.
    // P33a — redact secrets in payloads before persistence so we never store
    // user keys (their own or others') in trace events. Defensive: if a
    // tool result accidentally returns an API key string, this catches it.
    const cols = ['"runId"', '"ts"', '"eventType"', "payload", '"durationMs"', '"parentEventId"'];
    const placeholders: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const e of events) {
      const redacted = redactSecretsDeep(e.payload);
      placeholders.push(`($${i}, $${i+1}, $${i+2}, $${i+3}, $${i+4}, $${i+5})`);
      params.push(e.runId, e.ts, e.eventType, JSON.stringify(redacted), e.durationMs || null, e.parentEventId || null);
      i += 6;
    }
    try {
      await pool().query(
        `INSERT INTO trace_events (${cols.join(",")}) VALUES ${placeholders.join(",")}`,
        params,
      );
    } catch (err) {
      // Trace flush failures are non-fatal — we don't want to break user-facing
      // chat just because traces couldn't be written. Log and continue.
      console.error("[trace flush]", err);
    }
    return { flushed: events.length };
  }
}

// =================== READ ENDPOINTS ===================

export async function getRun(runId: string, userId: string): Promise<any | null> {
  const r = await pool().query(
    `SELECT * FROM trace_runs WHERE id=$1 AND "userId"=$2`,
    [runId, userId],
  );
  return r.rows[0] || null;
}

export async function getEventsForRun(runId: string, userId: string): Promise<any[]> {
  // Verify ownership via the run's userId before returning events.
  const own = await pool().query(`SELECT "userId" FROM trace_runs WHERE id=$1`, [runId]);
  if (!own.rows[0] || own.rows[0].userId !== userId) return [];
  const r = await pool().query(
    `SELECT id, "ts", "eventType", payload, "durationMs", "parentEventId"
     FROM trace_events WHERE "runId"=$1 ORDER BY "ts" ASC, id ASC`,
    [runId],
  );
  return r.rows;
}

export async function getRunsForThread(threadId: string, userId: string, limit = 50): Promise<any[]> {
  const r = await pool().query(
    `SELECT * FROM trace_runs
     WHERE "threadId"=$1 AND "userId"=$2
     ORDER BY "startedAt" DESC LIMIT $3`,
    [threadId, userId, limit],
  );
  return r.rows;
}
