// P65 — Server-side sink for events mirrored from the Codex companion.
//
// The browser-driven Codex Companion path means the hosted server isn't
// in the request path of a turn. To preserve our trace store and
// audit log, the companion (and/or browser) POSTs every notable event
// to /api/codex/events. This module owns the storage + sequencing +
// idempotency contract.
//
// Each event carries:
//
//   - runTicket  — signed envelope from issueRunTicket(). The route
//                  verifies it before calling persistMirroredEvents.
//   - runId      — copied from the ticket; the ticket's runId is
//                  authoritative.
//   - sequence   — monotonically increasing per (runId, source). We
//                  enforce strict-monotonic-by-source so a buggy
//                  client can't backfill earlier events.
//   - source     — "browser" | "companion" | "codex". Lets the audit
//                  view group events by emitter.
//   - eventType  — short string (e.g. "thread/started", "approval/required").
//   - timestamp  — emitter-side unix ms (we also stamp serverReceivedAt).
//   - payload    — already-redacted JSON. The mirror layer redacts
//                  again before persistence as defense in depth.
//   - idempotencyKey — opaque string. Two events with the same
//                  (runId, source, idempotencyKey) collapse to one row.
//
// We never persist authorization headers, raw access tokens, refresh
// tokens, capability tokens, or callback URLs. The route runs every
// payload through redactRpcEnvelope() before INSERT.
//
// Storage: codex_run_events. We don't try to be a generic time-series
// engine — this is a small audit log keyed on runId. Trace queries
// (counts, latency, etc.) can be added later by joining against the
// runs table.

import { createHash } from "node:crypto";
import { pool } from "../db";
import { redactJson } from "./redact";

let _initialized = false;

export async function ensureEventMirrorSchema(): Promise<void> {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS codex_run_events (
      "id" BIGSERIAL PRIMARY KEY,
      "runId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "orgId" TEXT,
      "threadId" TEXT,
      "agentId" TEXT,
      "pairSessionId" TEXT,
      "providerMode" TEXT NOT NULL,
      "source" TEXT NOT NULL,           -- 'browser' | 'companion' | 'codex'
      "sequence" BIGINT NOT NULL,        -- monotonic per (runId, source)
      "eventType" TEXT NOT NULL,
      "emittedAt" BIGINT NOT NULL,
      "serverReceivedAt" BIGINT NOT NULL,
      "idempotencyKey" TEXT NOT NULL,
      "redactedPayload" JSONB NOT NULL,
      UNIQUE ("runId","source","idempotencyKey")
    );
    CREATE INDEX IF NOT EXISTS "codex_run_events_runId_idx"
      ON codex_run_events("runId");
    CREATE INDEX IF NOT EXISTS "codex_run_events_userId_idx"
      ON codex_run_events("userId");
    CREATE INDEX IF NOT EXISTS "codex_run_events_runId_seq_idx"
      ON codex_run_events("runId","source","sequence");
  `);
  _initialized = true;
}

export type CodexEventSource = "browser" | "companion" | "codex";

export interface MirroredEventInput {
  source: CodexEventSource;
  sequence: number;
  eventType: string;
  emittedAt: number;          // unix ms from emitter
  idempotencyKey: string;
  payload: any;
}

export interface MirroredEventContext {
  runId: string;
  userId: string;
  orgId: string | null;
  agentId: string | null;
  threadId: string;
  pairSessionId: string | null;
  providerMode: string;
}

// ─── Validation ────────────────────────────────────────────────────────

const KNOWN_SOURCES: CodexEventSource[] = ["browser", "companion", "codex"];

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB per event after redaction
// P65.1 — anything bigger than 1 MB on the raw side is treated as a
// bug and refused outright. The (64 KB, 1 MB] range gets the
// truncation stub treatment so failure / approval / tool events
// remain debuggable.
const MAX_RAW_BYTES = 1024 * 1024; // 1 MB hard cap on incoming JSON
const TRUNC_PREVIEW_BYTES = 4 * 1024; // 4 KB JSON snippet inside the stub
const MAX_EVENT_TYPE_LEN = 128;
const MAX_IDEMPOTENCY_LEN = 256;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateMirroredEvent(e: MirroredEventInput): ValidationResult {
  if (!e || typeof e !== "object") return { ok: false, reason: "missing_event" };
  if (!KNOWN_SOURCES.includes(e.source)) {
    return { ok: false, reason: `unknown source: ${String(e.source)}` };
  }
  if (typeof e.sequence !== "number" || !Number.isInteger(e.sequence) || e.sequence < 0) {
    return { ok: false, reason: "sequence must be a non-negative integer" };
  }
  if (typeof e.eventType !== "string" || e.eventType.length === 0 || e.eventType.length > MAX_EVENT_TYPE_LEN) {
    return { ok: false, reason: "eventType invalid" };
  }
  if (typeof e.idempotencyKey !== "string" || e.idempotencyKey.length === 0 || e.idempotencyKey.length > MAX_IDEMPOTENCY_LEN) {
    return { ok: false, reason: "idempotencyKey invalid" };
  }
  if (typeof e.emittedAt !== "number" || !Number.isFinite(e.emittedAt) || e.emittedAt < 0) {
    return { ok: false, reason: "emittedAt invalid" };
  }
  return { ok: true };
}

// ─── Persistence ───────────────────────────────────────────────────────

export interface PersistResult {
  inserted: number;
  duplicates: number;
  outOfOrder: number;
  invalid: number;
  // P65.1 — number of events that got the truncation stub treatment
  // (still inserted, but with `truncated: true` on the stored payload).
  truncated: number;
}

// P65.1 — Build a truncation stub when the redacted payload is too big.
// We keep:
//   - top-level keys (so the trace viewer shows what fields were there)
//   - a JSON-prefix snippet
//   - the original size for debugging
//   - the `truncated: true` + `truncationReason` flag
function buildTruncationStub(redactedPayload: any, originalSize: number): any {
  const stub: any = {
    truncated: true,
    truncationReason: "oversize",
    originalSizeBytes: originalSize,
  };
  if (redactedPayload && typeof redactedPayload === "object" && !Array.isArray(redactedPayload)) {
    stub.topLevelKeys = Object.keys(redactedPayload).slice(0, 64);
  } else {
    stub.topLevelType = Array.isArray(redactedPayload) ? "array" : typeof redactedPayload;
  }
  // Keep a JSON prefix as a debugging crumb. The redactor has already
  // run, so secrets are already replaced with [REDACTED:*] markers.
  let preview: string;
  try {
    preview = JSON.stringify(redactedPayload).slice(0, TRUNC_PREVIEW_BYTES);
  } catch {
    preview = "[unserializable]";
  }
  stub.previewJson = preview;
  return stub;
}

export async function persistMirroredEvents(
  ctx: MirroredEventContext,
  events: MirroredEventInput[],
  opts: { now?: number } = {},
): Promise<PersistResult> {
  await ensureEventMirrorSchema();
  const now = opts.now ?? Date.now();
  const result: PersistResult = { inserted: 0, duplicates: 0, outOfOrder: 0, invalid: 0, truncated: 0 };
  if (!Array.isArray(events) || events.length === 0) return result;

  // Per-source highest sequence already on disk for this run. We use
  // this to reject backfill (sequence ≤ persisted max).
  const maxSeqRows = await pool().query(
    `SELECT "source", MAX("sequence")::bigint AS "max"
       FROM codex_run_events
      WHERE "runId" = $1
      GROUP BY "source"`,
    [ctx.runId],
  );
  const maxSeqBySource = new Map<string, number>();
  for (const row of maxSeqRows.rows) {
    maxSeqBySource.set(row.source, Number(row.max));
  }

  // Process in order of (source, sequence) ascending so we update our
  // in-memory ceiling correctly.
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.source !== b.e.source) return a.e.source < b.e.source ? -1 : 1;
      return a.e.sequence - b.e.sequence;
    });

  for (const { e } of sorted) {
    const v = validateMirroredEvent(e);
    if (!v.ok) {
      result.invalid++;
      continue;
    }
    const ceiling = maxSeqBySource.get(e.source) ?? -1;
    if (e.sequence <= ceiling) {
      // Could be a duplicate (idempotency key already on disk) or an
      // out-of-order rewrite. Either way we don't accept the lower
      // sequence; the unique constraint also catches the duplicate
      // case so we don't return false success.
      // Probe by idempotency key — if it's already there, count as
      // duplicate; otherwise out-of-order.
      const probe = await pool().query(
        `SELECT 1 FROM codex_run_events
          WHERE "runId" = $1 AND "source" = $2 AND "idempotencyKey" = $3
          LIMIT 1`,
        [ctx.runId, e.source, e.idempotencyKey],
      );
      if (probe.rowCount && probe.rowCount > 0) result.duplicates++;
      else result.outOfOrder++;
      continue;
    }

    // Defense-in-depth redaction. The route already redacts; we redact
    // again before INSERT so a future caller that bypasses the route
    // can't poison the trace store.
    //
    // We use `redactJson` here (not `redactRpcEnvelope`) because event
    // payloads are arbitrary objects, NOT JSON-RPC envelopes. Using
    // the envelope-shaped redactor on an arbitrary object would silently
    // drop most fields by returning a near-empty `{ jsonrpc: undefined,
    // id: undefined, method: undefined }` object, which would also
    // trick the size check.
    //
    // We also enforce the size cap on the RAW payload first, before
    // redaction, so a 100 MB payload that happens to compress under
    // redaction can never reach the DB.
    //
    // P65.1 — Truncation policy. When a payload exceeds MAX_PAYLOAD_BYTES
    // we DON'T silently drop it. Approval requests, errors, and tool
    // results carry the only debugging signal we'll have for a failed
    // run. We:
    //
    //   1. Try the redacted payload first; if it fits, persist whole.
    //   2. If it doesn't, build a TRUNCATED stub that preserves the
    //      essential debug metadata: the original approximate size, a
    //      `truncated: true` flag, the redacted top-level keys, and a
    //      JSON-prefix snippet capped at TRUNC_PREVIEW_BYTES.
    //   3. Stamp `truncationReason: "oversize"` on the stub so the
    //      trace viewer can surface a "payload truncated" badge.
    //
    // The very-large-raw-payload (≥ MAX_RAW_BYTES, 1 MB) branch still
    // fails closed (counts as invalid). Anything in the (64 KB,
    // 1 MB] range gets truncated.
    let preRedactSize: number;
    let rawJson: string;
    try {
      rawJson = JSON.stringify(e.payload);
      preRedactSize = rawJson.length;
    } catch {
      result.invalid++;
      continue;
    }
    if (preRedactSize > MAX_RAW_BYTES) {
      // Anything this big is almost certainly a bug; refuse outright.
      result.invalid++;
      continue;
    }
    const safePayload = redactJson(e.payload);
    let json = JSON.stringify(safePayload);
    let stored: any = safePayload;
    let didTruncate = false;
    if (json.length > MAX_PAYLOAD_BYTES) {
      const stub = buildTruncationStub(safePayload, preRedactSize);
      stored = stub;
      json = JSON.stringify(stub);
      didTruncate = true;
      // The stub is bounded in size by construction (≤ a few KB) but
      // we re-check defensively. If the stub itself overflows it
      // means a single key name or scalar is huge — drop entirely.
      if (json.length > MAX_PAYLOAD_BYTES) {
        result.invalid++;
        continue;
      }
    }

    const upsert = await pool().query(
      `INSERT INTO codex_run_events
         ("runId","userId","orgId","threadId","agentId","pairSessionId",
          "providerMode","source","sequence","eventType","emittedAt",
          "serverReceivedAt","idempotencyKey","redactedPayload")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
       ON CONFLICT ("runId","source","idempotencyKey") DO NOTHING`,
      [
        ctx.runId,
        ctx.userId,
        ctx.orgId,
        ctx.threadId,
        ctx.agentId,
        ctx.pairSessionId,
        ctx.providerMode,
        e.source,
        e.sequence,
        e.eventType,
        e.emittedAt,
        now,
        e.idempotencyKey,
        // `stored` is the redacted payload OR the truncation stub.
        // We always serialize through json above to enforce the cap,
        // so re-stringify the same value here for the DB row.
        JSON.stringify(stored),
      ],
    );
    if (upsert.rowCount === 1) {
      result.inserted++;
      if (didTruncate) result.truncated++;
      maxSeqBySource.set(e.source, e.sequence);
    } else {
      result.duplicates++;
    }
  }

  return result;
}

export async function listMirroredEvents(opts: {
  userId: string;
  runId: string;
  limit?: number;
}): Promise<Array<{
  id: number;
  source: CodexEventSource;
  sequence: number;
  eventType: string;
  emittedAt: number;
  serverReceivedAt: number;
  idempotencyKey: string;
  redactedPayload: any;
}>> {
  await ensureEventMirrorSchema();
  const limit = Math.min(opts.limit ?? 500, 5000);
  const r = await pool().query(
    `SELECT "id","source","sequence","eventType","emittedAt",
            "serverReceivedAt","idempotencyKey","redactedPayload"
       FROM codex_run_events
      WHERE "runId" = $1 AND "userId" = $2
      ORDER BY "id" ASC
      LIMIT $3`,
    [opts.runId, opts.userId, limit],
  );
  return r.rows.map((row: any) => ({
    id: Number(row.id),
    source: row.source,
    sequence: Number(row.sequence),
    eventType: row.eventType,
    emittedAt: Number(row.emittedAt),
    serverReceivedAt: Number(row.serverReceivedAt),
    idempotencyKey: row.idempotencyKey,
    redactedPayload: row.redactedPayload,
  }));
}

// Stable idempotency key helper for clients that don't have a natural id.
export function deriveIdempotencyKey(parts: { source: CodexEventSource; sequence: number; eventType: string; emittedAt: number; }): string {
  return createHash("sha256")
    .update(`${parts.source}|${parts.sequence}|${parts.eventType}|${parts.emittedAt}`)
    .digest("hex");
}
