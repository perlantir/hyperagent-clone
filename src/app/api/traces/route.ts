// P28a — list trace runs.
//   GET /api/traces?threadId={id}  → trace runs for that thread
//   GET /api/traces                → recent trace runs for the user (last 50)
//
// Distinct from /api/runs which serves the legacy scheduled-runs surface.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRunsForThread } from "@/lib/traces";
import { pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const threadId = url.searchParams.get("threadId");
  if (threadId) {
    const runs = await getRunsForThread(threadId, user.id);
    return NextResponse.json({ runs });
  }
  const r = await pool().query(
    `SELECT * FROM trace_runs WHERE "userId"=$1 ORDER BY "startedAt" DESC LIMIT 50`,
    [user.id],
  );
  return NextResponse.json({ runs: r.rows });
}
