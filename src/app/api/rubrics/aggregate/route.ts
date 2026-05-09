// P48 — eval-history aggregate endpoint.
//   GET /api/rubrics/aggregate?rubricId=...&agentId=...&from=...&to=...
//   Returns the bundle the dashboard needs in a single round trip:
//     summary / daily / perCriterion / perRubric / topFailing.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { aggregateEvaluations } from "@/lib/rubrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const rubricId = url.searchParams.get("rubricId") || undefined;
  // agentId="null" → only evaluations not bound to any agent (rare); omitted
  // → don't filter by agent at all.
  const agentParam = url.searchParams.get("agentId");
  const agentId = agentParam === "null" ? null : agentParam || undefined;
  const from = url.searchParams.get("from") ? Number(url.searchParams.get("from")) : undefined;
  const to = url.searchParams.get("to") ? Number(url.searchParams.get("to")) : undefined;

  const data = await aggregateEvaluations(user.id, { rubricId, agentId, from, to });
  return NextResponse.json(data);
}
