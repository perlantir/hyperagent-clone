// P33a — Sliding-window per-user rate limiter, Postgres-backed.
//
// In-memory rate limiters don't survive Vercel cold starts and don't share
// state across regions. Postgres is durable, simple, and good enough for the
// QPS levels we're protecting against (one user spamming v1/chat to burn
// credits, scraping public endpoints, etc.).
//
// Algorithm: discrete time buckets keyed by floor(now / windowMs). Each
// (userId, namespace, bucketKey) row gets atomic INCREMENT via UPSERT. A
// caller with count > max in the current bucket is rejected.
//
// Tradeoff: discrete buckets allow up to 2× max in the worst case (last
// request in window N + first request in window N+1). For our threat model
// — preventing abuse, not enforcing exact pricing — that's fine. If we ever
// need true sliding windows we'd switch to a script-based redis path.

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
  constructor(public namespace: string, public retryAfterMs: number) {
    super(`rate limit exceeded for ${namespace}, retry in ${Math.ceil(retryAfterMs/1000)}s`);
  }
}

export interface RateLimitOptions {
  userId: string;
  namespace: string;       // e.g. "v1_chat", "image_gen", "browser_session"
  maxRequests: number;
  windowMs: number;
}

// Check + increment atomically. Throws RateLimitError if over cap.
// Note: caller catches and converts to HTTP 429 + Retry-After header.
export async function enforceRateLimit(opts: RateLimitOptions): Promise<{ count: number; remaining: number }> {
  await ensureSchema();
  const now = Date.now();
  const bucketKey = Math.floor(now / opts.windowMs);
  const expiresAt = (bucketKey + 1) * opts.windowMs + 60_000; // expire 1 min after bucket window ends

  // ON CONFLICT increments the count. RETURNING gives us the new count atomically.
  const r = await pool().query(
    `INSERT INTO rate_limit_buckets ("userId", namespace, "bucketKey", count, "expiresAt")
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT ("userId", namespace, "bucketKey")
     DO UPDATE SET count = rate_limit_buckets.count + 1
     RETURNING count`,
    [opts.userId, opts.namespace, bucketKey, expiresAt],
  );
  const count = Number(r.rows[0].count);

  if (count > opts.maxRequests) {
    const retryAfter = (bucketKey + 1) * opts.windowMs - now;
    throw new RateLimitError(opts.namespace, retryAfter);
  }

  return { count, remaining: opts.maxRequests - count };
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
