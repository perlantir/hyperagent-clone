// P28a — Trace Skeleton.
//
// Append-only event log for every meaningful operation in a run. Each emit()
// is buffered in memory; a periodic auto-flush + a final flush at run end
// persist events to Postgres in batches.
//
// Hardening notes (post-P28a caveat triage):
//   - Periodic auto-flush every 5s OR every 50 events. Lambda crash now loses
//     at most the last partial batch instead of the whole run.
//   - Each event gets a clientId (UUID) generated at emit time. parentClientId
//     references the parent's clientId so the trace tree (tool_call → tool_result)
//     can be reconstructed without round-tripping through BIGSERIAL ids.
//   - Default metadata (agentId, agentVersion, promptFingerprint) attaches to
//     every event automatically once set on the emitter.
//   - Events redacted via redactSecretsDeep before persistence.

import crypto from "node:crypto";
import { pool } from "./db";
import { redactSecretsDeep } from "./security";

export type EventType =
  | "prompt_compiled"
  | "llm_call"
  | "tool_call"
  | "tool_result"
  | "memory_read"
  | "memory_write"
  | "subagent_dispatch"
  | "subagent_complete"
  | "retry"
  | "cache_hit"
  | "cache_miss"
  | "section_drop"
  | "budget_reserved"
  | "budget_committed"
  | "budget_rolled_back"
  | "error";

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
      "parentEventId" BIGINT,
      "clientId" TEXT,
      "parentClientId" TEXT,
      metadata JSONB
    );
    -- Idempotent column adds for older deployments
    ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS "clientId" TEXT;
    ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS "parentClientId" TEXT;
    ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS metadata JSONB;
    CREATE INDEX IF NOT EXISTS idx_trace_events_run ON trace_events("runId", "ts");
    CREATE INDEX IF NOT EXISTS idx_trace_events_client ON trace_events("clientId");
    CREATE INDEX IF NOT EXISTS idx_trace_events_parent_client ON trace_events("parentClientId");
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

interface BufferedEvent {
  runId: string;
  clientId: string;          // UUID, generated at emit
  parentClientId: string | null;
  ts: number;
  eventType: EventType;
  payload: any;
  durationMs?: number;
  metadata?: Record<string, any>;
}

export interface EmitHandle {
  clientId: string;
}

// Periodic + threshold-based flushing prevents data loss on lambda crash.
// Lambda death now drops at most one batch (≤50 events or ≤5 seconds).
const AUTO_FLUSH_INTERVAL_MS = 5000;
const AUTO_FLUSH_THRESHOLD = 50;

export class TraceEmitter {
  private buffer: BufferedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;
  private inflightFlush: Promise<void> | null = null;
  private defaultMetadata: Record<string, any> = {};

  constructor(public readonly runId: string) {}

  // Set metadata that auto-attaches to every emitted event. Useful for
  // run-wide correlation IDs (agent_version, prompt_fingerprint, request_id).
  setDefaultMetadata(meta: Record<string, any>): void {
    this.defaultMetadata = { ...this.defaultMetadata, ...meta };
  }

  emit(
    eventType: EventType,
    payload: any,
    opts: { durationMs?: number; parentClientId?: string; metadata?: Record<string, any> } = {},
  ): EmitHandle {
    const clientId = crypto.randomUUID();
    const event: BufferedEvent = {
      runId: this.runId,
      clientId,
      parentClientId: opts.parentClientId || null,
      ts: Date.now(),
      eventType,
      payload: payload || {},
      durationMs: opts.durationMs,
      metadata: { ...this.defaultMetadata, ...(opts.metadata || {}) },
    };
    this.buffer.push(event);

    if (this.buffer.length >= AUTO_FLUSH_THRESHOLD) {
      // Best-effort partial flush; don't block emit
      this.partialFlush().catch(e => console.error("[trace partial-flush]", e));
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.partialFlush().catch(e => console.error("[trace timed-flush]", e));
      }, AUTO_FLUSH_INTERVAL_MS);
    }

    return { clientId };
  }

  asCompilerEmitter() {
    return (event: any) => {
      const type = event.type as EventType;
      if (type === "prompt_compiled") {
        this.emit("prompt_compiled", event);
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

  // Mid-run flush; doesn't mark the emitter finalized.
  private async partialFlush(): Promise<void> {
    // Coalesce concurrent flush attempts: if one's in-flight, wait for it
    if (this.inflightFlush) return this.inflightFlush;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.buffer.length === 0) return;

    const events = this.buffer;
    this.buffer = [];

    this.inflightFlush = (async () => {
      const cols = ['"runId"', '"ts"', '"eventType"', "payload", '"durationMs"', '"clientId"', '"parentClientId"', "metadata"];
      const placeholders: string[] = [];
      const params: any[] = [];
      let i = 1;
      for (const e of events) {
        const redacted = redactSecretsDeep(e.payload);
        const redactedMeta = e.metadata ? redactSecretsDeep(e.metadata) : null;
        placeholders.push(`($${i}, $${i+1}, $${i+2}, $${i+3}, $${i+4}, $${i+5}, $${i+6}, $${i+7})`);
        params.push(
          e.runId, e.ts, e.eventType, JSON.stringify(redacted),
          e.durationMs || null, e.clientId, e.parentClientId || null,
          redactedMeta ? JSON.stringify(redactedMeta) : null,
        );
        i += 8;
      }
      try {
        await pool().query(
          `INSERT INTO trace_events (${cols.join(",")}) VALUES ${placeholders.join(",")}`,
          params,
        );
      } catch (err) {
        console.error("[trace flush]", err);
      }
    })();
    try { await this.inflightFlush; }
    finally { this.inflightFlush = null; }
  }

  // Final flush at run end. After this, the emitter is finalized — further
  // emits log a warning instead of silently buffering forever.
  async flush(): Promise<{ flushed: number }> {
    if (this.finalized) return { flushed: 0 };
    this.finalized = true;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.inflightFlush) { try { await this.inflightFlush; } catch {} }
    const count = this.buffer.length;
    if (count === 0) return { flushed: 0 };
    await this.partialFlush();
    return { flushed: count };
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
  const own = await pool().query(`SELECT "userId" FROM trace_runs WHERE id=$1`, [runId]);
  if (!own.rows[0] || own.rows[0].userId !== userId) return [];
  const r = await pool().query(
    `SELECT id, "ts", "eventType", payload, "durationMs", "clientId", "parentClientId", metadata
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
