// P29 — Idempotency keys for replay-safe operations.
//
// Three places this matters today:
//   1. Stripe webhooks — Stripe retries on 5xx for up to 3 days. Without dedup
//      by event.id, a single $20 purchase credits the user 5x.
//   2. Cron runs — Vercel may fire a cron twice during deploys or retries.
//      Without dedup by (cronPath + minute), scheduled agents run twice.
//   3. User double-clicks — same key submitted twice in quick succession.
//
// Pattern: every replay-sensitive mutation takes a key, looks up
// `idempotency_log` table with that key, and either:
//   - First call: insert key + run handler + cache result
//   - Subsequent calls: return cached result without re-running
//
// Keys are scoped by `namespace` so different surfaces can't collide.
// TTL defaults to 7 days; old rows can be pruned by the cron sweeper.

import { pool } from "./db";

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS idempotency_log (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "expiresAt" BIGINT NOT NULL,
      result JSONB,
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'completed' | 'failed'
      PRIMARY KEY (namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_log("expiresAt");
  `);
  _initialized = true;
}

export interface IdempotencyOptions {
  namespace: string;        // e.g. "stripe_webhook", "cron"
  key: string;              // e.g. event.id, "cron:2026-05-08T19:00"
  ttlSeconds?: number;       // default 7 days
}

// Run `fn` exactly once for a given (namespace, key). Subsequent calls within
// the TTL return the cached result without re-running fn.
//
// The cached `result` is whatever fn() returned. If fn() throws, we record
// the failure and don't cache — the next call will retry. (Different from
// Stripe's at-most-once semantics; the platform-level "successful processing"
// is still best-effort.)
export async function withIdempotency<T>(
  opts: IdempotencyOptions,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  await ensureSchema();
  const ttl = (opts.ttlSeconds ?? 7 * 24 * 3600) * 1000;
  const now = Date.now();

  // Try to claim the key. ON CONFLICT DO NOTHING so concurrent calls race
  // safely — only one wins and runs fn().
  const claim = await pool().query(
    `INSERT INTO idempotency_log (namespace, key, "createdAt", "expiresAt", status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (namespace, key) DO NOTHING
     RETURNING namespace`,
    [opts.namespace, opts.key, now, now + ttl],
  );
  const claimed = claim.rows.length > 0;

  if (!claimed) {
    // Someone else (or our past self) holds this key. Look up cached result.
    const r = await pool().query(
      `SELECT status, result, "expiresAt" FROM idempotency_log
       WHERE namespace=$1 AND key=$2`,
      [opts.namespace, opts.key],
    );
    const row = r.rows[0];
    if (!row) {
      // Key disappeared between INSERT and SELECT (unlikely but possible).
      // Treat as fresh and run.
      return runAndStore(opts, fn);
    }
    if (row.status === "pending" && Number(row.expiresAt) > now) {
      // Another worker is still running. We could wait, but for webhooks
      // it's better to return success quickly so Stripe doesn't retry. Treat
      // as a successful replay (the original handler is processing).
      return { result: { processing: true } as any, replayed: true };
    }
    if (row.status === "completed" && row.result) {
      return { result: row.result as T, replayed: true };
    }
    if (row.status === "failed") {
      // Past failure — let this caller retry by deleting the failed row and
      // re-claiming. Concurrent retry-of-failed is fine.
      await pool().query(
        `DELETE FROM idempotency_log WHERE namespace=$1 AND key=$2 AND status='failed'`,
        [opts.namespace, opts.key],
      );
      return runAndStore(opts, fn);
    }
    // Expired — treat as fresh
    return runAndStore(opts, fn);
  }

  return runAndStore(opts, fn);
}

async function runAndStore<T>(
  opts: IdempotencyOptions,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  try {
    const result = await fn();
    await pool().query(
      `UPDATE idempotency_log SET status='completed', result=$3
       WHERE namespace=$1 AND key=$2`,
      [opts.namespace, opts.key, JSON.stringify(result ?? null)],
    );
    return { result, replayed: false };
  } catch (err) {
    await pool().query(
      `UPDATE idempotency_log SET status='failed', result=$3
       WHERE namespace=$1 AND key=$2`,
      [opts.namespace, opts.key, JSON.stringify({ error: (err as any)?.message || String(err) })],
    );
    throw err;
  }
}

// Sweeper — remove rows past their TTL. Called from /api/cron for periodic GC.
export async function pruneExpiredIdempotency(): Promise<number> {
  await ensureSchema();
  const r = await pool().query(
    `DELETE FROM idempotency_log WHERE "expiresAt" < $1`,
    [Date.now()],
  );
  return r.rowCount || 0;
}
