// P66c — companions-store tests with a fake Postgres pool.
//
// Covers:
//   - upsertCompanion creates a fresh row
//   - upsertCompanion updates an existing row idempotently
//   - listCompanionsForUser returns user-scoped rows
//   - getCompanion / revokeCompanion happy + foreign-user paths
//   - dispatch queue: enqueue → pending → markDelivered → drained
//   - per-(runId, direction) monotonic sequence
//   - prune helpers
//   - issueCompanionJwt + verifyCompanionJwt happy + tampered + expired

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// ─── In-memory fake pool ──────────────────────────────────────────────

interface Tables {
  companions: any[];
  connections: any[];
  dispatch: any[];
}
const tables: Tables = { companions: [], connections: [], dispatch: [] };
let nextConnId = 1;
let nextDispId = 1;

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [], rowCount: 0 };

    // ─── codex_companions ──────────────────────────────────────────
    if (/INSERT INTO codex_companions/.test(sql)) {
      const [id, userId, orgId, dn, os, nv, cv, codexV, firstSeen] = params;
      const lastSeen = firstSeen;
      const idx = tables.companions.findIndex((r) => r.id === id);
      if (idx >= 0) {
        const ex = tables.companions[idx];
        // Mirror the COALESCE logic.
        if (ex.userId !== userId) return { rows: [], rowCount: 0 };
        ex.lastSeenAt = Number(lastSeen);
        ex.displayName      = dn      ?? ex.displayName;
        ex.osPlatform       = os      ?? ex.osPlatform;
        ex.nodeVersion      = nv      ?? ex.nodeVersion;
        ex.companionVersion = cv      ?? ex.companionVersion;
        ex.codexVersion     = codexV  ?? ex.codexVersion;
        ex.revokedAt = null;
        ex.enabledForRuns = true;
        return { rows: [], rowCount: 1 };
      }
      tables.companions.push({
        id, userId, orgId,
        displayName: dn, osPlatform: os, nodeVersion: nv,
        companionVersion: cv, codexVersion: codexV,
        firstSeenAt: Number(firstSeen), lastSeenAt: Number(lastSeen),
        revokedAt: null, enabledForRuns: true,
      });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT \* FROM codex_companions WHERE "id"=\$1/.test(sql)) {
      const r = tables.companions.find((r) => r.id === params[0]);
      return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
    }
    if (/SELECT \* FROM codex_companions WHERE "userId"=\$1/.test(sql)) {
      const rs = tables.companions
        .filter((r) => r.userId === params[0])
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      return { rows: rs, rowCount: rs.length };
    }
    if (/UPDATE codex_companions/.test(sql) && /SET "revokedAt"/.test(sql)) {
      const [id, userId, now] = params;
      const r = tables.companions.find((r) => r.id === id && r.userId === userId && r.revokedAt === null);
      if (!r) return { rows: [], rowCount: 0 };
      r.revokedAt = Number(now);
      r.enabledForRuns = false;
      return { rows: [], rowCount: 1 };
    }

    // ─── codex_companion_connections ───────────────────────────────
    if (/INSERT INTO codex_companion_connections/.test(sql)) {
      const [companionId, relayNodeId, connectedAt] = params;
      const id = nextConnId++;
      tables.connections.push({
        id, companionId, relayNodeId,
        connectedAt: Number(connectedAt), disconnectedAt: null, disconnectReason: null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (/UPDATE codex_companion_connections/.test(sql)) {
      const [id, disconnectedAt, reason] = params;
      const r = tables.connections.find((r) => r.id === id && r.disconnectedAt === null);
      if (!r) return { rows: [], rowCount: 0 };
      r.disconnectedAt = Number(disconnectedAt);
      r.disconnectReason = reason;
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM codex_companion_connections/.test(sql)) {
      const cutoff = Number(params[0]);
      const before = tables.connections.length;
      tables.connections = tables.connections.filter((r) => r.connectedAt >= cutoff);
      return { rows: [], rowCount: before - tables.connections.length };
    }

    // ─── codex_run_dispatch_queue ──────────────────────────────────
    if (/INSERT INTO codex_run_dispatch_queue/.test(sql)) {
      const [runId, companionId, direction, kind, payloadJson, enqueuedAt] = params;
      // Compute sequence per (runId, direction).
      const existing = tables.dispatch.filter((r) => r.runId === runId && r.direction === direction);
      const seq = existing.length === 0 ? 0 : Math.max(...existing.map((r) => r.sequence)) + 1;
      const id = nextDispId++;
      const row = {
        id, runId, companionId, direction, kind, sequence: seq,
        payload: typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson,
        enqueuedAt: Number(enqueuedAt), deliveredAt: null,
      };
      tables.dispatch.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM codex_run_dispatch_queue/.test(sql) && /^\s*SELECT/i.test(sql)) {
      const [companionId] = params;
      const rs = tables.dispatch
        .filter((r) => r.companionId === companionId && r.direction === "to_companion" && r.deliveredAt === null)
        .sort((a, b) => a.id - b.id);
      return { rows: rs, rowCount: rs.length };
    }
    if (/UPDATE codex_run_dispatch_queue/.test(sql) && /SET "deliveredAt"/.test(sql)) {
      const [id, deliveredAt] = params;
      const r = tables.dispatch.find((r) => r.id === id && r.deliveredAt === null);
      if (!r) return { rows: [], rowCount: 0 };
      r.deliveredAt = Number(deliveredAt);
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM codex_run_dispatch_queue/.test(sql)) {
      const cutoff = Number(params[0]);
      const before = tables.dispatch.length;
      tables.dispatch = tables.dispatch.filter((r) => r.deliveredAt === null || r.deliveredAt >= cutoff);
      return { rows: [], rowCount: before - tables.dispatch.length };
    }

    return { rows: [], rowCount: 0 };
  },
};

const dbPath = require.resolve("../db");
(require as any).cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: () => fakePool },
};

const {
  upsertCompanion, listCompanionsForUser, getCompanion, revokeCompanion,
  recordCompanionConnect, recordCompanionDisconnect, pruneOldConnections,
  enqueueDispatch, listPendingDispatchesForCompanion, markDispatchDelivered, pruneOldDispatch,
  issueCompanionJwt, verifyCompanionJwt,
} = require("../codex/companions-store");

// Pin a known signing key so JWT tests are reproducible.
process.env.CODEX_RUN_TICKET_KEY = "p66c-companions-store-test-key";

(async () => {
  // ─── companion CRUD ───────────────────────────────────────────────
  const c1 = await upsertCompanion({
    userId: "u1",
    orgId: "o1",
    displayName: "MacBook Pro",
    osPlatform: "darwin",
    companionVersion: "0.1.0-alpha.0",
    codexVersion: "codex-cli 0.130.0",
    now: 1_000_000,
  });
  pass("upsert mints id starting with cmp_",
    typeof c1.id === "string" && c1.id.startsWith("cmp_"));
  pass("upsert returns the inserted row",
    c1.userId === "u1" && c1.displayName === "MacBook Pro" && c1.firstSeenAt === 1_000_000);

  // re-upsert same id should update lastSeenAt + COALESCE other fields
  const c1b = await upsertCompanion({
    userId: "u1",
    existingId: c1.id,
    nodeVersion: "v22.5.0",
    now: 2_000_000,
  });
  pass("re-upsert updates lastSeenAt",
    c1b.lastSeenAt === 2_000_000);
  pass("re-upsert preserves earlier fields (COALESCE)",
    c1b.displayName === "MacBook Pro" && c1b.osPlatform === "darwin");
  pass("re-upsert sets newly-provided fields",
    c1b.nodeVersion === "v22.5.0");

  // listCompanionsForUser
  const c2 = await upsertCompanion({ userId: "u1", displayName: "Linux box", now: 3_000_000 });
  const list = await listCompanionsForUser("u1");
  pass("list returns rows for user, newest first",
    list.length === 2 && list[0].lastSeenAt >= list[1].lastSeenAt);
  const otherList = await listCompanionsForUser("u-other");
  pass("list scoped to userId", otherList.length === 0);

  // getCompanion
  const got = await getCompanion(c1.id);
  pass("getCompanion returns the row", got?.id === c1.id);
  const missing = await getCompanion("cmp_does_not_exist");
  pass("getCompanion returns null on miss", missing === null);

  // revokeCompanion
  const okRevoke = await revokeCompanion({ companionId: c1.id, userId: "u1", now: 4_000_000 });
  pass("revoke succeeds for own companion", okRevoke === true);
  const c1after = await getCompanion(c1.id);
  pass("revoke flips revokedAt + enabledForRuns",
    c1after?.revokedAt === 4_000_000 && c1after?.enabledForRuns === false);
  const okRevokeAgain = await revokeCompanion({ companionId: c1.id, userId: "u1" });
  pass("revoke is idempotent (second revoke no-ops)", okRevokeAgain === false);
  const wrongUserRevoke = await revokeCompanion({ companionId: c2.id, userId: "u-other" });
  pass("revoke refuses foreign user", wrongUserRevoke === false);

  // ─── connection lifecycle ────────────────────────────────────────
  const connId = await recordCompanionConnect({
    companionId: c2.id, relayNodeId: "fly-iad-01", now: 5_000_000,
  });
  pass("recordCompanionConnect returns numeric id",
    typeof connId === "number" && connId > 0);
  await recordCompanionDisconnect({ connectionId: connId, reason: "client_close", now: 5_001_000 });
  pass("disconnect set on the row",
    tables.connections[0].disconnectedAt === 5_001_000
    && tables.connections[0].disconnectReason === "client_close");
  await recordCompanionDisconnect({ connectionId: connId, reason: "double_close", now: 9_999_999 });
  pass("disconnect is idempotent (second call no-ops)",
    tables.connections[0].disconnectedAt === 5_001_000);

  const pruned = await pruneOldConnections({ olderThanMs: 1, now: 5_002_000 });
  pass("prune deletes connections older than cutoff",
    pruned === 1 && tables.connections.length === 0);

  // ─── dispatch queue ─────────────────────────────────────────────
  const e1 = await enqueueDispatch({
    runId: "run_a", companionId: c2.id, direction: "to_companion",
    kind: "run_dispatch", payload: { foo: 1 }, now: 6_000_000,
  });
  const e2 = await enqueueDispatch({
    runId: "run_a", companionId: c2.id, direction: "to_companion",
    kind: "approval_decision", payload: { decision: "approved" }, now: 6_000_010,
  });
  pass("enqueue assigns sequence per (runId, direction): 0",
    e1.sequence === 0);
  pass("enqueue assigns sequence per (runId, direction): 1",
    e2.sequence === 1);
  // Different runId restarts at 0
  const e3 = await enqueueDispatch({
    runId: "run_b", companionId: c2.id, direction: "to_companion",
    kind: "run_dispatch", payload: {}, now: 6_000_020,
  });
  pass("different runId starts at sequence 0", e3.sequence === 0);

  // listPending
  const pending = await listPendingDispatchesForCompanion({ companionId: c2.id });
  pass("listPending returns 3 entries (none delivered yet)",
    pending.length === 3);
  pass("listPending sorted by id ASC",
    pending[0].id < pending[1].id && pending[1].id < pending[2].id);

  // markDelivered
  const ok1 = await markDispatchDelivered({ id: e1.id, now: 6_001_000 });
  pass("markDelivered first time returns true", ok1 === true);
  const ok2 = await markDispatchDelivered({ id: e1.id, now: 6_002_000 });
  pass("markDelivered idempotent (second time false)", ok2 === false);

  const pendingAfter = await listPendingDispatchesForCompanion({ companionId: c2.id });
  pass("listPending excludes delivered entries",
    pendingAfter.length === 2 && pendingAfter.every((p: any) => p.id !== e1.id));

  // pruneOldDispatch
  const prunedDisp = await pruneOldDispatch({ olderThanMs: 1, now: 7_000_000 });
  pass("pruneOldDispatch deletes only delivered+old rows",
    prunedDisp === 1);

  // ─── companion JWT ───────────────────────────────────────────────
  const { token, payload } = issueCompanionJwt({
    companionId: c2.id, userId: "u1",
    now: 8_000_000, ttlMs: 3600_000,
  });
  pass("JWT shape: payload.sub = companionId",
    payload.sub === c2.id);
  pass("JWT shape: payload.userId = u1",
    payload.userId === "u1");
  pass("JWT shape: nonce is hex of length 32",
    /^[0-9a-f]{32}$/.test(payload.nonce));
  pass("JWT token is dot-separated b64url",
    typeof token === "string" && token.split(".").length === 2);

  const v1 = verifyCompanionJwt(token, { now: 8_001_000 });
  pass("verify accepts our own token within TTL",
    v1.ok === true && (v1 as any).payload?.sub === c2.id);

  const v2 = verifyCompanionJwt(token, { now: 9_000_000 + 3601_000 });
  pass("verify rejects expired token",
    v2.ok === false && (v2 as any).reason === "expired");

  // tamper with payload
  const tamperedPayload = token.replace(/^./, "X");
  const v3 = verifyCompanionJwt(tamperedPayload, { now: 8_001_000 });
  pass("verify rejects tampered payload",
    v3.ok === false);

  // tamper with sig
  const tamperedSig = token.slice(0, -2) + "AA";
  const v4 = verifyCompanionJwt(tamperedSig, { now: 8_001_000 });
  pass("verify rejects tampered signature",
    v4.ok === false);

  if (failed > 0) {
    console.error(`\n${failed} companions-store test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-companions-store tests passed");
})();
