// Vercel Cron tick: runs every minute. Replaces the in-process setInterval
// scheduler from Phase 5. Vercel's deployment platform invokes this URL on
// the schedule defined in vercel.json.

import { NextResponse } from "next/server";
import { runDueSchedules } from "@/lib/scheduler";

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
  const result = await runDueSchedules();
  return NextResponse.json({ ok: true, ...result });
}
