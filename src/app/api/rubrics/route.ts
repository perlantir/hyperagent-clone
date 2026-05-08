// P26 — list + create rubrics.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listRubrics, createRubric } from "@/lib/rubrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rubrics = await listRubrics(user.id);
  return NextResponse.json({
    rubrics,
    counts: {
      total: rubrics.length,
      pinned: rubrics.filter(r => r.isPinned).length,
      builtin: rubrics.filter(r => r.isBuiltin).length,
    },
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body.name || !Array.isArray(body.criteria)) {
    return NextResponse.json({ error: "name and criteria[] required" }, { status: 400 });
  }
  const rubric = await createRubric({
    userId: user.id,
    name: body.name,
    description: body.description,
    scope: body.scope,
    scopeId: body.scopeId,
    criteria: body.criteria,
    passingThreshold: body.passingThreshold,
    judgePassingScore: body.judgePassingScore,
  });
  return NextResponse.json({ rubric });
}
