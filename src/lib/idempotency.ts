// P29 — Idempotency keys for replay-safe operations.
//
// Three places this matters today:
//   1. Stripe webhooks — Stripe retries on 5xx for up to 3 days, but the
//      official guidance is to dedup by event.id permanently in case a
//      retry happens beyond their window or via support replay. We default
//      Stripe namespace to 30 days.
//   2. Cron runs — Vercel may fire a cron twice during deploys or retries.
//      Without dedup by (cronPath + minute), scheduled agents run twice.
//   3. User double-clicks — same key submitted twice in quick succession.
//
// Pattern: every replay-sensitive mutation takes a key, looks up
// `idempotency_log` table with that key, and either:
//   - First call: insert key + run handler + cache result
//   - Subsequent calls: return cached result without re-running
//
// Inline GC: with 1% probability per call, prune expired rows. Belt and
// suspenders against a broken cron — the table never grows unbounded even
// if the hourly sweeper stops running.

import { pool } from "./db";

let _initialized = false;
let _lastInlinePruneAt = 0;

// Per-namespace defaults. Caller can override via opts.ttlSeconds.
const NAMESPACE_DEFAULT_TTL_SECONDS: Record<string, number> = {
  stripe_webhook: 30 * 24 * 3600,    // 30 days — Stripe recommends permanent
  cron: 600,                          // 10 minutes
  default: 7 * 24 * 3600,             // 7 days
};

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS idempotency_log (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "expiresAt" BIGINT NOT NULL,
      result JSONB,
      status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_log("expiresAt");
  `);
  _initialized = true;
}

// Inline GC: 1% chance per call, but at most once per minute per process.
// Belt-and-suspenders against a broken cron sweeper.
async function maybeInlinePrune(): Promise<void> {
  if (Math.random() > 0.01) return;
  if (Date.now() - _lastInlinePruneAt < 60_000) return;
  _lastInlinePruneAt = Date.now();
  try {
    await pool().query(
      `DELETE FROM idempotency_log WHERE "expiresAt" < $1`,
      [Date.now()],
    );
  } catch (e) {
    console.error("[idempotency inline prune]", e);
  }
}

export interface IdempotencyOptions {
  namespace: string;
  key: string;
  ttlSeconds?: number;       // override default
}

function defaultTtl(namespace: string): number {
  return NAMESPACE_DEFAULT_TTL_SECONDS[namespace] || NAMESPACE_DEFAULT_TTL_SECONDS.default;
}

export async function withIdempotency<T>(
  opts: IdempotencyOptions,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  await ensureSchema();
  // Best-effort inline GC; don't block the operation
  maybeInlinePrune().catch(() => {});

  const ttl = (opts.ttlSeconds ?? defaultTtl(opts.namespace)) * 1000;
  const now = Date.now();

  const claim = await pool().query(
    `INSERT INTO idempotency_log (namespace, key, "createdAt", "expiresAt", status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (namespace, key) DO NOTHING
     RETURNING namespace`,
    [opts.namespace, opts.key, now, now + ttl],
  );
  const claimed = claim.rows.length > 0;

  if (!claimed) {
    const r = await pool().query(
      `SELECT status, result, "expiresAt" FROM idempotency_log
       WHERE namespace=$1 AND key=$2`,
      [opts.namespace, opts.key],
    );
    const row = r.rows[0];
    if (!row) {
      return runAndStore(opts, fn);
    }
    if (row.status === "pending" && Number(row.expiresAt) > now) {
      return { result: { processing: true } as any, replayed: true };
    }
    if (row.status === "completed" && row.result) {
      return { result: row.result as T, replayed: true };
    }
    if (row.status === "failed") {
      await pool().query(
        `DELETE FROM idempotency_log WHERE namespace=$1 AND key=$2 AND status='failed'`,
        [opts.namespace, opts.key],
      );
      return runAndStore(opts, fn);
    }
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

export async function pruneExpiredIdempotency(): Promise<number> {
  await ensureSchema();
  const r = await pool().query(
    `DELETE FROM idempotency_log WHERE "expiresAt" < $1`,
    [Date.now()],
  );
  return r.rowCount || 0;
}
