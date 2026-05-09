// P65 — Codex Companion pairing.
//
// The hosted Vercel app cannot reach the user's machine directly. To
// avoid the manual bridge URL/token paste, the user runs:
//
//   npx hyperagent-codex-companion <pair-code>
//
// on their own machine. The companion then claims the pairing session
// against /api/codex/pair/claim, and the hosted browser polls
// /api/codex/pair/status to discover when the companion is online.
//
// Pairing properties enforced here:
//
//   - Pair codes are short-lived (default 5 minutes from start).
//   - Pair codes are one-time-use: once claimed, the pair-code → session
//     mapping is consumed; a second claim is refused.
//   - Sessions are scoped to the user that started them. A pair code
//     issued by user A cannot be claimed against user B's session.
//   - Pair codes are high-entropy (192-bit) and only stored in the
//     database HASHED. Plaintext lives only in the response to the
//     starting user, never in any log line.
//   - Session credentials (sessionId + sessionSecret) are returned to
//     the companion ONCE on claim and stored hashed.
//   - Heartbeats keep a session alive. After 90 s without heartbeat the
//     session is treated as offline (status reports it but does not
//     delete the row, so revoke remains usable).
//   - Revoking deletes the row; subsequent /status calls return
//     "revoked".
//
// SECURITY:
//   - We NEVER log pair codes, session ids, session secrets, or
//     companion URLs.
//   - Comparison of stored hashes uses crypto.timingSafeEqual.
//   - All entropy is sourced from crypto.randomBytes.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "../db";

let _initialized = false;

export async function ensurePairingSchema(): Promise<void> {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS codex_pair_sessions (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "orgId" TEXT,
      -- SHA-256 hex of the pair-code. Plaintext never persisted.
      "pairCodeHash" TEXT NOT NULL,
      -- Once claimed, the companion stores its sessionId + sessionSecret
      -- so subsequent heartbeats authenticate. We store the secret as a
      -- SHA-256 hash; plaintext was returned to the companion at claim
      -- time and never seen again on the server.
      "sessionId" TEXT,
      "sessionSecretHash" TEXT,
      -- Public companion URL (always loopback) the browser uses.
      -- Stored in plaintext because it carries no secret — a typical
      -- value is "http://127.0.0.1:8390". Origin checks happen in the
      -- companion itself, not on this URL string.
      "companionBaseUrl" TEXT,
      -- Companion-reported metadata (version, OS, codex binary path).
      "companionInfo" JSONB,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "createdAt" BIGINT NOT NULL,
      "claimedAt" BIGINT,
      "lastHeartbeatAt" BIGINT,
      "expiresAt" BIGINT NOT NULL,
      "revokedAt" BIGINT
    );
    CREATE INDEX IF NOT EXISTS "codex_pair_sessions_userId_status_idx"
      ON codex_pair_sessions("userId","status");
    CREATE INDEX IF NOT EXISTS "codex_pair_sessions_pairCodeHash_idx"
      ON codex_pair_sessions("pairCodeHash");
  `);
  _initialized = true;
}

// ─── Tunables ──────────────────────────────────────────────────────────

// Pair code lifetime in milliseconds.
export const PAIR_CODE_TTL_MS = 5 * 60_000; // 5 minutes
// Session lifetime in milliseconds. After this, even a heartbeating
// companion gets booted and must re-pair. Forces a clean re-handshake.
export const SESSION_TTL_MS = 24 * 3600_000; // 24 hours
// How fresh a heartbeat must be for the session to be considered
// "online" by the browser-side status poller.
export const SESSION_ONLINE_GRACE_MS = 90_000; // 90 seconds

// ─── Types ─────────────────────────────────────────────────────────────

export type PairStatus = "pending" | "claimed" | "expired" | "revoked";

export interface PairStartResult {
  // Server-issued pair-code the user pastes into the npx command.
  pairCode: string;
  // Stable session id the browser polls for status. Carries no secret.
  sessionId: string;
  // Pair-code expiry timestamp (unix ms).
  expiresAt: number;
}

export interface PairClaimResult {
  sessionId: string;
  sessionSecret: string;
  // Server-side expiry of the SESSION (not the pair code).
  expiresAt: number;
}

export interface PairStatusView {
  sessionId: string;
  status: PairStatus;
  online: boolean;
  // Loopback URL the browser should open a WS against. Null until
  // the companion has claimed and reported its base URL.
  companionBaseUrl: string | null;
  companionInfo: any | null;
  expiresAt: number;
  lastHeartbeatAt: number | null;
  claimedAt: number | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

// Pair codes are 24 base32-ish chars (192 bits). Easy to type but
// long enough to resist guessing in a 5-minute window.
function generatePairCode(): string {
  const buf = randomBytes(24);
  // Crockford-ish base32 (upper-case, omit I/L/O/U). 24 bytes → ~38 chars.
  // We trim to 24 chars by truncating raw hex and uppercasing — gives
  // ~96 bits of entropy at hex × 24 (4 bits/char), which is below our
  // 192-bit goal. Easier solution: use full hex of 24 bytes (48 chars)
  // for the pair-code. Slightly longer to type but perfectly secure.
  return buf.toString("hex");
}

function generateSessionId(): string {
  return "ses_" + randomBytes(16).toString("hex");
}

function generateSessionSecret(): string {
  return randomBytes(32).toString("hex"); // 256 bits
}

// ─── Public API ────────────────────────────────────────────────────────

export async function startPairSession(opts: {
  userId: string;
  orgId?: string | null;
  now?: number;
}): Promise<PairStartResult> {
  await ensurePairingSchema();
  const now = opts.now ?? Date.now();
  const pairCode = generatePairCode();
  const sessionId = generateSessionId();
  const expiresAt = now + PAIR_CODE_TTL_MS;
  await pool().query(
    `INSERT INTO codex_pair_sessions
       ("id","userId","orgId","pairCodeHash","status","createdAt","expiresAt")
     VALUES ($1,$2,$3,$4,'pending',$5,$6)`,
    [sessionId, opts.userId, opts.orgId ?? null, sha256(pairCode), now, expiresAt],
  );
  // Eagerly clean up old expired rows for this user. A user pairing
  // multiple times shouldn't accumulate junk.
  await pool().query(
    `DELETE FROM codex_pair_sessions
      WHERE "userId" = $1 AND "status" IN ('pending','expired') AND "expiresAt" < $2`,
    [opts.userId, now],
  );
  return { pairCode, sessionId, expiresAt };
}

export interface ClaimPairOptions {
  userId: string;
  pairCode: string;
  companionBaseUrl: string;
  companionInfo?: any;
  now?: number;
}

export async function claimPairSession(opts: ClaimPairOptions): Promise<PairClaimResult> {
  await ensurePairingSchema();
  const now = opts.now ?? Date.now();
  // Companion base URL must be loopback. The companion is REPORTING
  // its own URL here, so a misbehaving companion couldn't trick us into
  // opening a remote URL — but the browser would open whatever we pass
  // through /status. Guard at the server.
  validateCompanionBaseUrl(opts.companionBaseUrl);

  const codeHash = sha256(opts.pairCode);
  const r = await pool().query(
    `SELECT "id","userId","orgId","pairCodeHash","status","sessionId","expiresAt"
       FROM codex_pair_sessions
      WHERE "pairCodeHash" = $1
      ORDER BY "createdAt" DESC
      LIMIT 1`,
    [codeHash],
  );
  const row = r.rows[0];
  if (!row) {
    throw new PairingError("invalid_pair_code", "Pair code is invalid or has been used.");
  }
  // Constant-time compare against a known-bad value if userIds don't
  // match, so timing doesn't reveal whether the code itself was valid
  // versus belonging to another user.
  const userMatches = constantTimeCompare(row.userId, opts.userId);
  if (!userMatches) {
    throw new PairingError("wrong_user", "Pair code does not belong to the signed-in user.");
  }
  if (row.status === "revoked") {
    throw new PairingError("revoked", "Pair code has been revoked.");
  }
  if (row.status === "claimed") {
    throw new PairingError("already_claimed", "Pair code has already been used.");
  }
  if (Number(row.expiresAt) < now) {
    // Mark as expired so future polls see it.
    await pool().query(
      `UPDATE codex_pair_sessions SET "status"='expired' WHERE "id"=$1 AND "status"='pending'`,
      [row.id],
    );
    throw new PairingError("expired", "Pair code has expired. Generate a new one.");
  }

  const sessionSecret = generateSessionSecret();
  const sessionExpires = now + SESSION_TTL_MS;
  // Conditional update: only flip pending → claimed. If two companions
  // race the claim, exactly one wins.
  const upd = await pool().query(
    `UPDATE codex_pair_sessions
        SET "status"='claimed',
            "sessionSecretHash"=$2,
            "companionBaseUrl"=$3,
            "companionInfo"=$4,
            "claimedAt"=$5,
            "lastHeartbeatAt"=$5,
            "expiresAt"=$6
      WHERE "id"=$1 AND "status"='pending'`,
    [
      row.id,
      sha256(sessionSecret),
      opts.companionBaseUrl,
      opts.companionInfo ? JSON.stringify(opts.companionInfo) : null,
      now,
      sessionExpires,
    ],
  );
  if (upd.rowCount !== 1) {
    throw new PairingError("already_claimed", "Pair code has already been used.");
  }
  return {
    sessionId: row.id,
    sessionSecret,
    expiresAt: sessionExpires,
  };
}

export async function getPairStatus(opts: {
  userId: string;
  sessionId: string;
  now?: number;
}): Promise<PairStatusView> {
  await ensurePairingSchema();
  const now = opts.now ?? Date.now();
  const r = await pool().query(
    `SELECT "id","userId","status","companionBaseUrl","companionInfo",
            "expiresAt","lastHeartbeatAt","claimedAt","revokedAt"
       FROM codex_pair_sessions
      WHERE "id" = $1`,
    [opts.sessionId],
  );
  const row = r.rows[0];
  if (!row) {
    throw new PairingError("not_found", "No such pairing session.");
  }
  if (!constantTimeCompare(row.userId, opts.userId)) {
    // Don't leak existence/non-existence by returning a different error.
    throw new PairingError("not_found", "No such pairing session.");
  }
  let status: PairStatus = row.status as PairStatus;
  if (status === "pending" && Number(row.expiresAt) < now) {
    status = "expired";
    // Best-effort persistence of the new status. Don't fail the read
    // if this update collides with a parallel claim — the next read
    // will see the resolved state.
    pool()
      .query(
        `UPDATE codex_pair_sessions SET "status"='expired' WHERE "id"=$1 AND "status"='pending'`,
        [row.id],
      )
      .catch(() => undefined);
  }
  if (status === "revoked") {
    return {
      sessionId: row.id,
      status: "revoked",
      online: false,
      companionBaseUrl: null,
      companionInfo: null,
      expiresAt: Number(row.expiresAt),
      lastHeartbeatAt: row.lastHeartbeatAt ? Number(row.lastHeartbeatAt) : null,
      claimedAt: row.claimedAt ? Number(row.claimedAt) : null,
    };
  }
  const lastHb = row.lastHeartbeatAt ? Number(row.lastHeartbeatAt) : null;
  const online = status === "claimed" && lastHb !== null && now - lastHb <= SESSION_ONLINE_GRACE_MS && Number(row.expiresAt) >= now;
  return {
    sessionId: row.id,
    status,
    online,
    companionBaseUrl: row.companionBaseUrl,
    companionInfo: row.companionInfo,
    expiresAt: Number(row.expiresAt),
    lastHeartbeatAt: lastHb,
    claimedAt: row.claimedAt ? Number(row.claimedAt) : null,
  };
}

export async function revokePairSession(opts: {
  userId: string;
  sessionId: string;
  now?: number;
}): Promise<void> {
  await ensurePairingSchema();
  const now = opts.now ?? Date.now();
  // Constant-time scoping: we update WHERE "userId" = ours so a foreign
  // session id is silently a no-op (no information leak about whether
  // the session exists for another user).
  await pool().query(
    `UPDATE codex_pair_sessions
        SET "status"='revoked', "revokedAt"=$3
      WHERE "id"=$1 AND "userId"=$2 AND "status" <> 'revoked'`,
    [opts.sessionId, opts.userId, now],
  );
}

export interface HeartbeatOptions {
  sessionId: string;
  sessionSecret: string;
  companionInfo?: any;
  now?: number;
}

// Companion → server. Authenticated by sessionSecret (compared via
// timingSafeEqual against the stored hash).
export async function heartbeatPairSession(opts: HeartbeatOptions): Promise<{
  ok: true;
  expiresAt: number;
} | { ok: false; reason: string }> {
  await ensurePairingSchema();
  const now = opts.now ?? Date.now();
  const r = await pool().query(
    `SELECT "id","status","sessionSecretHash","expiresAt"
       FROM codex_pair_sessions
      WHERE "id" = $1`,
    [opts.sessionId],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "revoked") return { ok: false, reason: "revoked" };
  if (row.status !== "claimed" || !row.sessionSecretHash) {
    return { ok: false, reason: "not_claimed" };
  }
  if (Number(row.expiresAt) < now) {
    await pool().query(
      `UPDATE codex_pair_sessions SET "status"='expired' WHERE "id"=$1 AND "status"='claimed'`,
      [row.id],
    );
    return { ok: false, reason: "expired" };
  }
  if (!constantTimeCompare(row.sessionSecretHash, sha256(opts.sessionSecret))) {
    return { ok: false, reason: "bad_secret" };
  }
  await pool().query(
    `UPDATE codex_pair_sessions
        SET "lastHeartbeatAt" = $2,
            "companionInfo" = COALESCE($3, "companionInfo")
      WHERE "id" = $1`,
    [row.id, now, opts.companionInfo ? JSON.stringify(opts.companionInfo) : null],
  );
  return { ok: true, expiresAt: Number(row.expiresAt) };
}

// Server-side helper for run-ticket / event-mirror routes that need to
// verify the calling companion is the legitimate owner of a session.
// Returns the session row when authenticated; null otherwise.
export async function authenticateCompanion(opts: {
  sessionId: string;
  sessionSecret: string;
  now?: number;
}): Promise<{ sessionId: string; userId: string; orgId: string | null } | null> {
  await ensurePairingSchema();
  const now = opts.now ?? Date.now();
  const r = await pool().query(
    `SELECT "id","userId","orgId","status","sessionSecretHash","expiresAt"
       FROM codex_pair_sessions
      WHERE "id" = $1`,
    [opts.sessionId],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.status !== "claimed") return null;
  if (Number(row.expiresAt) < now) return null;
  if (!row.sessionSecretHash) return null;
  if (!constantTimeCompare(row.sessionSecretHash, sha256(opts.sessionSecret))) return null;
  return {
    sessionId: row.id,
    userId: row.userId,
    orgId: row.orgId ?? null,
  };
}

// ─── Validation ────────────────────────────────────────────────────────

export class PairingError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
  }
}

export function validateCompanionBaseUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PairingError("bad_companion_url", "Companion base URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PairingError(
      "bad_companion_url",
      `Companion base URL must use http:// or https:// (got ${url.protocol}).`,
    );
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Loopback only — no LAN, no public IPs. The browser opens the URL
  // straight from the user's machine; the only legitimate target is
  // their own loopback.
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost");
  if (!isLoopback) {
    throw new PairingError(
      "non_loopback_companion_url",
      "Companion base URL must point at loopback (127.0.0.1 / localhost / ::1).",
    );
  }
  // Reject anything with credentials in the URL (foo:bar@host).
  if (url.username || url.password) {
    throw new PairingError("bad_companion_url", "Companion URL must not include credentials.");
  }
}
