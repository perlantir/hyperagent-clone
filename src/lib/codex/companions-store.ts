// P66c — Companion device registry + connection log + dispatch queue.
//
// Three tables, one helper module:
//
//   codex_companions
//     One row per registered companion device. Survives sessions.
//     Created when a companion's first pair-claim succeeds. Soft-revoke
//     via revokedAt; admin reuses same row on re-pair.
//
//   codex_companion_connections
//     One row per WS lifecycle (connect → disconnect). Used for
//     observability + admin "is companion X currently online?".
//     Pruned after 30 days.
//
//   codex_run_dispatch_queue
//     Bidirectional offline queue for companion ↔ relay messages.
//     Vercel writes `to_companion` rows (run dispatch / approval
//     decision / cancel); the relay drains them in sequence order
//     when the WS comes online. Companion writes are mirrored via
//     /api/codex/relay/inbox into codex_run_events; we don't
//     duplicate them here.
//
// Rollback notes:
//   - All tables use BIGSERIAL ids, no FK fan-out beyond user/companion.
//   - DROP TABLE in reverse order: dispatch_queue, connections,
//     companions. Codex_audit_log carries enough trace to reconstruct
//     companion identity history if needed.
//   - The columns are append-mostly; no ON UPDATE CASCADE.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "../db";

let _initialized = false;

export async function ensureCompanionsSchema(): Promise<void> {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS codex_companions (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "orgId" TEXT,
      "displayName" TEXT,
      "osPlatform" TEXT,
      "nodeVersion" TEXT,
      "companionVersion" TEXT,
      "codexVersion" TEXT,
      "firstSeenAt" BIGINT NOT NULL,
      "lastSeenAt" BIGINT NOT NULL,
      "revokedAt" BIGINT,
      "enabledForRuns" BOOLEAN NOT NULL DEFAULT true
    );
    CREATE INDEX IF NOT EXISTS "codex_companions_userId_idx"
      ON codex_companions("userId");
    CREATE INDEX IF NOT EXISTS "codex_companions_orgId_revoked_idx"
      ON codex_companions("orgId","revokedAt");

    CREATE TABLE IF NOT EXISTS codex_companion_connections (
      "id" BIGSERIAL PRIMARY KEY,
      "companionId" TEXT NOT NULL,
      "relayNodeId" TEXT,
      "connectedAt" BIGINT NOT NULL,
      "disconnectedAt" BIGINT,
      "disconnectReason" TEXT
    );
    CREATE INDEX IF NOT EXISTS "codex_companion_connections_cid_idx"
      ON codex_companion_connections("companionId","connectedAt" DESC);

    CREATE TABLE IF NOT EXISTS codex_run_dispatch_queue (
      "id" BIGSERIAL PRIMARY KEY,
      "runId" TEXT NOT NULL,
      "companionId" TEXT NOT NULL,
      "direction" TEXT NOT NULL,    -- 'to_companion' | 'from_companion'
      "kind" TEXT NOT NULL,          -- 'run_dispatch' | 'approval_decision' | 'cancel' | 'ack'
      "sequence" BIGINT NOT NULL,
      "payload" JSONB NOT NULL,
      "enqueuedAt" BIGINT NOT NULL,
      "deliveredAt" BIGINT
    );
    CREATE INDEX IF NOT EXISTS "codex_dispatch_queue_pending_idx"
      ON codex_run_dispatch_queue("companionId","deliveredAt") WHERE "deliveredAt" IS NULL;
    CREATE INDEX IF NOT EXISTS "codex_dispatch_queue_runseq_idx"
      ON codex_run_dispatch_queue("runId","sequence");
  `);
  _initialized = true;
}

// ─── Companion device CRUD ────────────────────────────────────────────

export interface CompanionDevice {
  id: string;
  userId: string;
  orgId: string | null;
  displayName: string | null;
  osPlatform: string | null;
  nodeVersion: string | null;
  companionVersion: string | null;
  codexVersion: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  enabledForRuns: boolean;
}

export interface UpsertCompanionInput {
  userId: string;
  orgId?: string | null;
  displayName?: string | null;
  osPlatform?: string | null;
  nodeVersion?: string | null;
  companionVersion?: string | null;
  codexVersion?: string | null;
  // When provided, update the existing row keyed on this id; else
  // mint a new id.
  existingId?: string | null;
  now?: number;
}

export async function upsertCompanion(input: UpsertCompanionInput): Promise<CompanionDevice> {
  await ensureCompanionsSchema();
  const now = input.now ?? Date.now();
  const id = input.existingId ?? `cmp_${randomBytes(12).toString("hex")}`;
  await pool().query(
    `INSERT INTO codex_companions
       ("id","userId","orgId","displayName","osPlatform","nodeVersion",
        "companionVersion","codexVersion","firstSeenAt","lastSeenAt","enabledForRuns")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,true)
     ON CONFLICT ("id") DO UPDATE
       SET "lastSeenAt" = EXCLUDED."lastSeenAt",
           "displayName"      = COALESCE(EXCLUDED."displayName",      codex_companions."displayName"),
           "osPlatform"       = COALESCE(EXCLUDED."osPlatform",       codex_companions."osPlatform"),
           "nodeVersion"      = COALESCE(EXCLUDED."nodeVersion",      codex_companions."nodeVersion"),
           "companionVersion" = COALESCE(EXCLUDED."companionVersion", codex_companions."companionVersion"),
           "codexVersion"     = COALESCE(EXCLUDED."codexVersion",     codex_companions."codexVersion"),
           "revokedAt"        = NULL,
           "enabledForRuns"   = true
       WHERE codex_companions."userId" = EXCLUDED."userId"`,
    [
      id, input.userId, input.orgId ?? null,
      input.displayName ?? null, input.osPlatform ?? null,
      input.nodeVersion ?? null, input.companionVersion ?? null,
      input.codexVersion ?? null, now,
    ],
  );
  const row = (await pool().query(
    `SELECT * FROM codex_companions WHERE "id"=$1`, [id],
  )).rows[0];
  if (!row) throw new Error("upsertCompanion failed");
  return rowToCompanion(row);
}

export async function listCompanionsForUser(userId: string): Promise<CompanionDevice[]> {
  await ensureCompanionsSchema();
  const r = await pool().query(
    `SELECT * FROM codex_companions WHERE "userId"=$1 ORDER BY "lastSeenAt" DESC`,
    [userId],
  );
  return r.rows.map(rowToCompanion);
}

export async function getCompanion(id: string): Promise<CompanionDevice | null> {
  await ensureCompanionsSchema();
  const r = await pool().query(
    `SELECT * FROM codex_companions WHERE "id"=$1`, [id],
  );
  return r.rows[0] ? rowToCompanion(r.rows[0]) : null;
}

export async function revokeCompanion(opts: { companionId: string; userId: string; now?: number }): Promise<boolean> {
  await ensureCompanionsSchema();
  const now = opts.now ?? Date.now();
  const r = await pool().query(
    `UPDATE codex_companions
        SET "revokedAt" = $3, "enabledForRuns" = false
      WHERE "id" = $1 AND "userId" = $2 AND "revokedAt" IS NULL`,
    [opts.companionId, opts.userId, now],
  );
  return (r.rowCount || 0) > 0;
}

function rowToCompanion(row: any): CompanionDevice {
  return {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    displayName: row.displayName,
    osPlatform: row.osPlatform,
    nodeVersion: row.nodeVersion,
    companionVersion: row.companionVersion,
    codexVersion: row.codexVersion,
    firstSeenAt: Number(row.firstSeenAt),
    lastSeenAt: Number(row.lastSeenAt),
    revokedAt: row.revokedAt ? Number(row.revokedAt) : null,
    enabledForRuns: !!row.enabledForRuns,
  };
}

// ─── Companion connections (WS lifecycle log) ─────────────────────────

export async function recordCompanionConnect(opts: {
  companionId: string;
  relayNodeId?: string | null;
  now?: number;
}): Promise<number> {
  await ensureCompanionsSchema();
  const r = await pool().query(
    `INSERT INTO codex_companion_connections ("companionId","relayNodeId","connectedAt")
     VALUES ($1,$2,$3) RETURNING "id"`,
    [opts.companionId, opts.relayNodeId ?? null, opts.now ?? Date.now()],
  );
  return Number(r.rows[0].id);
}

export async function recordCompanionDisconnect(opts: {
  connectionId: number;
  reason?: string;
  now?: number;
}): Promise<void> {
  await ensureCompanionsSchema();
  await pool().query(
    `UPDATE codex_companion_connections
        SET "disconnectedAt" = $2, "disconnectReason" = $3
      WHERE "id" = $1 AND "disconnectedAt" IS NULL`,
    [opts.connectionId, opts.now ?? Date.now(), opts.reason ?? null],
  );
}

export async function pruneOldConnections(opts: { olderThanMs?: number; now?: number } = {}): Promise<number> {
  await ensureCompanionsSchema();
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.olderThanMs ?? 30 * 24 * 3600_000);
  const r = await pool().query(
    `DELETE FROM codex_companion_connections WHERE "connectedAt" < $1`,
    [cutoff],
  );
  return r.rowCount || 0;
}

// ─── Dispatch queue (Vercel ↔ companion via relay) ────────────────────

export type DispatchDirection = "to_companion" | "from_companion";
export type DispatchKind = "run_dispatch" | "approval_decision" | "cancel" | "ack";

export interface DispatchEntry {
  id: number;
  runId: string;
  companionId: string;
  direction: DispatchDirection;
  kind: DispatchKind;
  sequence: number;
  payload: any;
  enqueuedAt: number;
  deliveredAt: number | null;
}

export async function enqueueDispatch(opts: {
  runId: string;
  companionId: string;
  direction: DispatchDirection;
  kind: DispatchKind;
  payload: any;
  now?: number;
}): Promise<DispatchEntry> {
  await ensureCompanionsSchema();
  const now = opts.now ?? Date.now();
  // Per-(runId, direction) monotonic sequence. We compute it inside
  // the query so two concurrent enqueues get distinct sequences.
  const r = await pool().query(
    `INSERT INTO codex_run_dispatch_queue
       ("runId","companionId","direction","kind","sequence","payload","enqueuedAt")
     VALUES (
       $1, $2, $3, $4,
       (SELECT COALESCE(MAX("sequence"), -1) + 1
          FROM codex_run_dispatch_queue
          WHERE "runId" = $1 AND "direction" = $3),
       $5::jsonb, $6
     )
     RETURNING *`,
    [opts.runId, opts.companionId, opts.direction, opts.kind, JSON.stringify(opts.payload), now],
  );
  return rowToDispatch(r.rows[0]);
}

export async function listPendingDispatchesForCompanion(opts: {
  companionId: string;
  limit?: number;
}): Promise<DispatchEntry[]> {
  await ensureCompanionsSchema();
  const r = await pool().query(
    `SELECT * FROM codex_run_dispatch_queue
      WHERE "companionId" = $1 AND "direction" = 'to_companion' AND "deliveredAt" IS NULL
      ORDER BY "id" ASC
      LIMIT $2`,
    [opts.companionId, Math.min(opts.limit ?? 100, 1000)],
  );
  return r.rows.map(rowToDispatch);
}

export async function markDispatchDelivered(opts: {
  id: number;
  now?: number;
}): Promise<boolean> {
  await ensureCompanionsSchema();
  const r = await pool().query(
    `UPDATE codex_run_dispatch_queue
        SET "deliveredAt" = $2
      WHERE "id" = $1 AND "deliveredAt" IS NULL`,
    [opts.id, opts.now ?? Date.now()],
  );
  return (r.rowCount || 0) > 0;
}

export async function pruneOldDispatch(opts: { olderThanMs?: number; now?: number } = {}): Promise<number> {
  await ensureCompanionsSchema();
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.olderThanMs ?? 7 * 24 * 3600_000);
  const r = await pool().query(
    `DELETE FROM codex_run_dispatch_queue
      WHERE "deliveredAt" IS NOT NULL AND "deliveredAt" < $1`,
    [cutoff],
  );
  return r.rowCount || 0;
}

function rowToDispatch(row: any): DispatchEntry {
  return {
    id: Number(row.id),
    runId: row.runId,
    companionId: row.companionId,
    direction: row.direction as DispatchDirection,
    kind: row.kind as DispatchKind,
    sequence: Number(row.sequence),
    payload: row.payload,
    enqueuedAt: Number(row.enqueuedAt),
    deliveredAt: row.deliveredAt ? Number(row.deliveredAt) : null,
  };
}

// ─── Companion JWT (Vercel issues, relay verifies) ────────────────────
//
// We reuse the same HMAC signing key as the run-ticket; that lives in
// CODEX_RUN_TICKET_KEY / APP_SECRET. JWT carries:
//   sub:        companionId
//   iat / exp:  ms epochs
//   userId:     for relay-side authorization checks
//   nonce:      32-byte random
//
// Format: payloadB64.sigB64 (no header field; same shape as run ticket).
// Refreshed every hour via /api/codex/pair/heartbeat response.

const JWT_TTL_MS = 60 * 60_000;

export interface CompanionJwtPayload {
  v: 1;
  sub: string;          // companionId
  userId: string;
  iat: number;
  exp: number;
  nonce: string;
}

function loadHmacKey(): Buffer {
  const sources = [
    process.env.CODEX_RUN_TICKET_KEY,
    process.env.APP_SECRET,
    process.env.NEXTAUTH_SECRET,
    process.env.SESSION_SECRET,
  ].filter((s): s is string => typeof s === "string" && s.length >= 16);
  if (sources.length > 0) {
    return createHmac("sha256", "codex-companion-jwt-v1").update(sources[0]).digest();
  }
  const inProd = process.env.VERCEL === "1" || !!process.env.VERCEL_ENV || process.env.NODE_ENV === "production";
  if (inProd) {
    throw new Error("CODEX_RUN_TICKET_KEY (or APP_SECRET) must be configured to issue companion JWTs in production.");
  }
  return randomBytes(32);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function issueCompanionJwt(opts: {
  companionId: string;
  userId: string;
  now?: number;
  ttlMs?: number;
}): { token: string; payload: CompanionJwtPayload } {
  const now = opts.now ?? Date.now();
  const payload: CompanionJwtPayload = {
    v: 1,
    sub: opts.companionId,
    userId: opts.userId,
    iat: now,
    exp: now + (opts.ttlMs ?? JWT_TTL_MS),
    nonce: randomBytes(16).toString("hex"),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", loadHmacKey()).update(payloadB64).digest();
  return { token: `${payloadB64}.${b64url(sig)}`, payload };
}

export type CompanionJwtVerification =
  | { ok: true; payload: CompanionJwtPayload }
  | { ok: false; reason: string };

export function verifyCompanionJwt(token: string, opts: { now?: number } = {}): CompanionJwtVerification {
  if (typeof token !== "string" || token.length < 8) return { ok: false, reason: "malformed" };
  const ix = token.indexOf(".");
  if (ix < 0) return { ok: false, reason: "malformed" };
  const payloadB64 = token.slice(0, ix);
  const sigB64 = token.slice(ix + 1);
  const expectedSig = createHmac("sha256", loadHmacKey()).update(payloadB64).digest();
  let providedSig: Buffer;
  try { providedSig = b64urlDecode(sigB64); }
  catch { return { ok: false, reason: "bad_sig_encoding" }; }
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: CompanionJwtPayload;
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")); }
  catch { return { ok: false, reason: "bad_payload" }; }
  if (payload.v !== 1) return { ok: false, reason: "version" };
  const now = opts.now ?? Date.now();
  if (typeof payload.exp !== "number" || payload.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
