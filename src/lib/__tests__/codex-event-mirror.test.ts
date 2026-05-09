// P65 — event mirror persistence tests.
//
// Verifies persistMirroredEvents enforces:
//   - validation of source / sequence / eventType / idempotencyKey
//   - per-(runId, source) monotonic sequence
//   - duplicates are de-duplicated via the unique constraint
//   - out-of-order events are rejected
//   - payloads larger than 64 KB are refused
//   - redaction strips obvious secrets

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

interface Row {
  id: number;
  runId: string;
  userId: string;
  source: string;
  sequence: number;
  eventType: string;
  emittedAt: number;
  serverReceivedAt: number;
  idempotencyKey: string;
  redactedPayload: any;
}
const rows: Row[] = [];
let nextId = 1;

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/CREATE TABLE/.test(sql) || /CREATE INDEX/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT "source", MAX/.test(sql)) {
      const runId = params[0];
      const map = new Map<string, number>();
      for (const r of rows) {
        if (r.runId !== runId) continue;
        if (!map.has(r.source) || r.sequence > (map.get(r.source) as number)) {
          map.set(r.source, r.sequence);
        }
      }
      return { rows: Array.from(map.entries()).map(([source, max]) => ({ source, max })), rowCount: map.size };
    }
    if (/INSERT INTO codex_run_events/.test(sql)) {
      const [runId, userId, _orgId, _threadId, _agentId, _pairSessionId, _providerMode, source, sequence, eventType, emittedAt, serverReceivedAt, idempotencyKey, payloadJson] = params;
      // Unique constraint: (runId, source, idempotencyKey).
      if (rows.some(r => r.runId === runId && r.source === source && r.idempotencyKey === idempotencyKey)) {
        return { rows: [], rowCount: 0 };
      }
      rows.push({
        id: nextId++,
        runId,
        userId,
        source,
        sequence: Number(sequence),
        eventType,
        emittedAt: Number(emittedAt),
        serverReceivedAt: Number(serverReceivedAt),
        idempotencyKey,
        redactedPayload: typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson,
      });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT 1 FROM codex_run_events/.test(sql)) {
      const [runId, source, idempotencyKey] = params;
      const found = rows.some(r => r.runId === runId && r.source === source && r.idempotencyKey === idempotencyKey);
      return { rows: found ? [{}] : [], rowCount: found ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  },
};

const dbPath = require.resolve("../db");
(require as any).cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: () => fakePool },
};

const { persistMirroredEvents, validateMirroredEvent, deriveIdempotencyKey } = require("../codex/event-mirror");

const ctx = {
  runId: "run_test1",
  userId: "u1",
  orgId: null,
  agentId: null,
  threadId: "t1",
  pairSessionId: "ses_1",
  providerMode: "codexChatGPTCompanion",
};

(async () => {
  // ─── validation ────────────────────────────────────────────────────
  pass("validate accepts well-formed event",
    validateMirroredEvent({
      source: "companion", sequence: 0, eventType: "thread/started",
      emittedAt: Date.now(), idempotencyKey: "k1", payload: {},
    }).ok === true);
  pass("validate rejects unknown source",
    validateMirroredEvent({
      source: "alien" as any, sequence: 0, eventType: "x", emittedAt: 0, idempotencyKey: "k", payload: {},
    }).ok === false);
  pass("validate rejects negative sequence",
    validateMirroredEvent({
      source: "companion", sequence: -1, eventType: "x", emittedAt: 0, idempotencyKey: "k", payload: {},
    }).ok === false);
  pass("validate rejects empty eventType",
    validateMirroredEvent({
      source: "companion", sequence: 0, eventType: "", emittedAt: 0, idempotencyKey: "k", payload: {},
    }).ok === false);

  // ─── basic persistence ────────────────────────────────────────────
  {
    const r = await persistMirroredEvents(ctx, [
      { source: "companion", sequence: 0, eventType: "companion/connected", emittedAt: 1000, idempotencyKey: "a", payload: {} },
      { source: "companion", sequence: 1, eventType: "thread/started", emittedAt: 1100, idempotencyKey: "b", payload: { threadId: "ct_1" } },
      { source: "codex", sequence: 0, eventType: "turn/started", emittedAt: 1200, idempotencyKey: "c", payload: { turnId: "tu_1" } },
    ]);
    pass("inserted 3 rows", r.inserted === 3);
    pass("zero duplicates first time", r.duplicates === 0);
    pass("zero invalid", r.invalid === 0);
    pass("rows actually in DB", rows.filter(x => x.runId === "run_test1").length === 3);
  }

  // ─── duplicate idempotency keys collapse ──────────────────────────
  {
    const r = await persistMirroredEvents(ctx, [
      { source: "companion", sequence: 1, eventType: "thread/started", emittedAt: 1100, idempotencyKey: "b", payload: { threadId: "ct_1" } },
    ]);
    pass("duplicate idempotency key counted as duplicate, not inserted",
      r.duplicates === 1 && r.inserted === 0);
  }

  // ─── out-of-order rejected ────────────────────────────────────────
  {
    const r = await persistMirroredEvents(ctx, [
      // companion has already reached sequence=1; sequence=0 is backfill
      { source: "companion", sequence: 0, eventType: "earlier", emittedAt: 999, idempotencyKey: "z", payload: {} },
    ]);
    pass("out-of-order sequence rejected",
      r.outOfOrder === 1 && r.inserted === 0);
  }

  // ─── per-source ceiling is independent ────────────────────────────
  {
    // codex source max is 0 from earlier; codex sequence=1 should insert.
    const r = await persistMirroredEvents(ctx, [
      { source: "codex", sequence: 1, eventType: "turn/itemAdded", emittedAt: 1300, idempotencyKey: "cd1", payload: {} },
    ]);
    pass("per-source sequence ceiling tracked independently",
      r.inserted === 1);
  }

  // ─── redaction strips secrets ─────────────────────────────────────
  {
    await persistMirroredEvents(ctx, [
      {
        source: "browser", sequence: 0, eventType: "test/secret",
        emittedAt: 2000, idempotencyKey: "secret-1",
        payload: {
          authorization: "Bearer eyJabc.def.ghi-1234567890",
          accessToken: "sk-very-secret-token-123456",
          nested: { refresh_token: "rtok_xxx", message: "hi" },
        },
      },
    ]);
    const row = rows.find(r => r.idempotencyKey === "secret-1");
    pass("redaction blanks authorization field",
      typeof row?.redactedPayload?.authorization === "string"
      && /^\[REDACTED/i.test(row.redactedPayload.authorization));
    pass("redaction blanks accessToken field",
      typeof row?.redactedPayload?.accessToken === "string"
      && /^\[REDACTED/i.test(row.redactedPayload.accessToken));
    pass("redaction blanks nested refresh_token field",
      typeof row?.redactedPayload?.nested?.refresh_token === "string"
      && /^\[REDACTED/i.test(row.redactedPayload.nested.refresh_token));
    pass("redaction preserves harmless nested fields",
      row?.redactedPayload?.nested?.message === "hi");
  }

  // ─── oversize between 64 KB and 1 MB → truncation stub ───────────
  {
    const big = "x".repeat(70 * 1024); // 70 KB → over 64 KB cap
    const r = await persistMirroredEvents(ctx, [
      {
        source: "browser", sequence: 1, eventType: "huge_but_truncatable",
        emittedAt: 3000, idempotencyKey: "trunc-1",
        payload: { harmless_field: "ok", lol: big, summary: "what failed" },
      },
    ]);
    pass("64 KB+ payload counted as inserted",
      r.inserted === 1 && r.invalid === 0);
    pass("inserted event marked truncated",
      r.truncated === 1);

    const stub = rows.find(x => x.idempotencyKey === "trunc-1")?.redactedPayload;
    pass("stored stub has truncated=true",
      stub?.truncated === true);
    pass("stored stub records truncationReason=oversize",
      stub?.truncationReason === "oversize");
    pass("stored stub records originalSizeBytes",
      typeof stub?.originalSizeBytes === "number" && stub.originalSizeBytes >= 70 * 1024);
    pass("stored stub preserves topLevelKeys",
      Array.isArray(stub?.topLevelKeys)
      && stub.topLevelKeys.includes("harmless_field")
      && stub.topLevelKeys.includes("summary"));
    pass("stored stub includes a previewJson snippet",
      typeof stub?.previewJson === "string" && stub.previewJson.length > 0);
  }

  // ─── 1 MB+ raw payload rejected outright ──────────────────────────
  {
    const huge = "y".repeat(2 * 1024 * 1024); // 2 MB
    const r = await persistMirroredEvents(ctx, [
      {
        source: "browser", sequence: 2, eventType: "way_too_big",
        emittedAt: 4000, idempotencyKey: "huge-1",
        payload: { lol: huge },
      },
    ]);
    pass("≥1 MB raw payload counted as invalid",
      r.invalid === 1 && r.inserted === 0 && r.truncated === 0);
  }

  // ─── deriveIdempotencyKey is stable ───────────────────────────────
  {
    const a = deriveIdempotencyKey({ source: "browser", sequence: 5, eventType: "x", emittedAt: 1000 });
    const b = deriveIdempotencyKey({ source: "browser", sequence: 5, eventType: "x", emittedAt: 1000 });
    pass("deriveIdempotencyKey is deterministic", a === b && a.length === 64);
    const c = deriveIdempotencyKey({ source: "browser", sequence: 6, eventType: "x", emittedAt: 1000 });
    pass("deriveIdempotencyKey changes with sequence", a !== c);
  }

  if (failed > 0) {
    console.error(`\n${failed} event-mirror test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-event-mirror tests passed");
})();
