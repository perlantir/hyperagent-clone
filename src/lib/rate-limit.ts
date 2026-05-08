// P33a — Per-key sliding-window rate limiter, Postgres-backed.
//
// Uses the classic sliding-window-counter approximation: count requests in
// the current bucket plus a weighted contribution from the prior bucket
// based on how much of the prior window is still "present" in the sliding
// view. Worst-case slop is ~10% rather than the 2× of pure-discrete buckets,
// without the cost of a Redis Lua script or true sliding-log storage.
//
// Algorithm (per-call):
//   1. bucketKey = floor(now / windowMs)
//   2. INSERT/UPDATE current bucket count atomically
//   3. SELECT prior bucket (bucketKey - 1) count if present
//   4. effectiveCount = currentCount + priorCount * (1 - elapsedInCurrent/windowMs)
//   5. If effectiveCount > maxRequests, throw RateLimitError
//
// Callers can enforce multiple namespaces in series for layered protection
// (e.g., login enforces both per-email AND per-IP limits).

import { pool } from "./db";

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      "userId" TEXT NOT NULL,
      namespace TEXT NOT NULL,
      "bucketKey" BIGINT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      "expiresAt" BIGINT NOT NULL,
      PRIMARY KEY ("userId", namespace, "bucketKey")
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_expires ON rate_limit_buckets("expiresAt");
  `);
  _initialized = true;
}

export class RateLimitError extends Error {
  status = 429;
  constructor(public namespace: string, public retryAfterMs: number, public limit: number) {
    super(`rate limit exceeded for ${namespace}, retry in ${Math.ceil(retryAfterMs/1000)}s`);
  }
}

export interface RateLimitOptions {
  // The bucket key — typically userId, IP, or `prefix:identifier`. Different
  // identifier shapes can share the same namespace (e.g., the namespace
  // "auth_login" is enforced separately on email and IP).
  userId: string;
  namespace: string;
  maxRequests: number;
  windowMs: number;
}

// Check + increment atomically. Throws RateLimitError if over cap.
export async function enforceRateLimit(opts: RateLimitOptions): Promise<{ count: number; remaining: number }> {
  await ensureSchema();
  const now = Date.now();
  const bucketKey = Math.floor(now / opts.windowMs);
  const elapsedInCurrent = now - bucketKey * opts.windowMs;
  const expiresAt = (bucketKey + 1) * opts.windowMs + 60_000;

  // 1. Atomically increment current bucket
  const currentRes = await pool().query(
    `INSERT INTO rate_limit_buckets ("userId", namespace, "bucketKey", count, "expiresAt")
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT ("userId", namespace, "bucketKey")
     DO UPDATE SET count = rate_limit_buckets.count + 1
     RETURNING count`,
    [opts.userId, opts.namespace, bucketKey, expiresAt],
  );
  const currentCount = Number(currentRes.rows[0].count);

  // 2. Look up prior bucket count for sliding-window weighting
  const priorRes = await pool().query(
    `SELECT count FROM rate_limit_buckets
     WHERE "userId"=$1 AND namespace=$2 AND "bucketKey"=$3`,
    [opts.userId, opts.namespace, bucketKey - 1],
  );
  const priorCount = priorRes.rows[0] ? Number(priorRes.rows[0].count) : 0;

  // 3. Compute effective count via sliding-window approximation
  const priorWeight = 1 - (elapsedInCurrent / opts.windowMs);
  const effectiveCount = currentCount + priorCount * priorWeight;

  if (effectiveCount > opts.maxRequests) {
    // Compute when the user can retry: when enough of the prior bucket has
    // aged out that effectiveCount would dip below max.
    // Approximation: wait until next bucket starts.
    const retryAfter = (bucketKey + 1) * opts.windowMs - now;
    throw new RateLimitError(opts.namespace, retryAfter, opts.maxRequests);
  }

  return { count: Math.ceil(effectiveCount), remaining: Math.max(0, opts.maxRequests - Math.ceil(effectiveCount)) };
}

// Convenience: extract a stable IP key from an inbound Request. Falls back
// to "unknown" when no IP is available (local dev, missing headers).
export function ipKeyFromRequest(req: Request): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    null;
  return ip ? `ip:${ip}` : "ip:unknown";
}

// Periodic GC. Called by /api/cron sweeper.
export async function pruneExpiredRateLimits(): Promise<number> {
  await ensureSchema();
  const r = await pool().query(
    `DELETE FROM rate_limit_buckets WHERE "expiresAt" < $1`,
    [Date.now()],
  );
  return r.rowCount || 0;
}
