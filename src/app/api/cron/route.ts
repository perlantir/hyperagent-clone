// Vercel Cron tick. P29 — wrapped in withIdempotency to dedup double-fires
// during deploys/retries. Key is bucketed to the minute so two invocations
// in the same minute see the same key and the second one returns the
// cached result without re-running schedules.
//
// Also runs the idempotency log sweeper hourly to GC expired keys.

import { NextResponse } from "next/server";
import { runDueSchedules } from "@/lib/scheduler";
import { withIdempotency, pruneExpiredIdempotency } from "@/lib/idempotency";
import { pruneExpiredRateLimits } from "@/lib/rate-limit";
import { replayDlq } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>. We accept that or
  // an x-vercel-cron header signal.
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET;
  const isVercelCron = req.headers.get("x-vercel-cron") === "1";
  if (secret && !isVercelCron && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Bucket the idempotency key to the minute. Vercel may fire a cron twice
  // during a deploy; the second fire shares the bucket and skips work.
  const minute = Math.floor(Date.now() / 60_000);
  const key = `cron:${minute}`;

  const { result, replayed } = await withIdempotency(
    { namespace: "cron", key, ttlSeconds: 600 }, // 10min — well past any retry window
    async () => {
      const scheduleResult = await runDueSchedules();
      // Hourly sweeps. Each is wrapped in its own try so one failure doesn't
      // block the others. Counts surface in the cron response for monitoring.
      let sweptIdempotency = 0;
      let sweptRateLimits = 0;
      let dlqReplayed = 0, dlqFailed = 0;
      if (minute % 60 === 0) {
        try { sweptIdempotency = await pruneExpiredIdempotency(); }
        catch (e) { console.error("[cron sweep idempotency]", e); }
        try { sweptRateLimits = await pruneExpiredRateLimits(); }
        catch (e) { console.error("[cron sweep rate_limit]", e); }
        // P33a — replay any audit events that had to fall back to the DLQ.
        // If primary INSERT was failing transiently, replay should succeed
        // now and audit_log gets backfilled.
        try {
          const r = await replayDlq(100);
          dlqReplayed = r.replayed; dlqFailed = r.failed;
        } catch (e) { console.error("[cron replay dlq]", e); }
      }
      return { ...scheduleResult, sweptIdempotency, sweptRateLimits, dlqReplayed, dlqFailed };
    },
  );

  return NextResponse.json({ ok: true, replayed, ...result });
}
