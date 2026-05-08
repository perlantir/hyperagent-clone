// P26 — list rubric evaluations.
//   GET /api/rubric-evaluations              → recent evaluations for user
//   GET /api/rubric-evaluations?runId=...    → evaluations for a specific run

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listEvaluationsForRun, listRecentEvaluations } from "@/lib/rubrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  const evaluations = runId
    ? await listEvaluationsForRun(runId, user.id)
    : await listRecentEvaluations(user.id, 50);
  return NextResponse.json({ evaluations });
}
