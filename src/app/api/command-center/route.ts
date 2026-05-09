// P32 — Command Center snapshot.
//   GET /api/command-center → { activeRuns, health, burnRate, schedules, balance }
//
// Single endpoint that fans out to the four aggregations in parallel. The
// dashboard polls this every few seconds for a live operational view.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getActiveRuns, getHealthSnapshot, getBurnRate, getScheduleStatus } from "@/lib/command-center";
import { balance } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [activeRuns, health, burnRate, schedules, bal] = await Promise.all([
    getActiveRuns(user.id),
    getHealthSnapshot(user.id),
    getBurnRate(user.id, 24),
    getScheduleStatus(user.id),
    balance(user.id),
  ]);

  return NextResponse.json({
    activeRuns,
    health,
    burnRate,
    schedules,
    balance: bal,
    serverTime: Date.now(),
  });
}
