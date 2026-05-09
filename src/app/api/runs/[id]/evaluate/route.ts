// P38 — Manual rubric evaluation against a run.
//
//   POST /api/runs/{runId}/evaluate
//   → { results: [...] }
//
// The auto-eval already fires after multi-step runs (P26). This endpoint
// lets users trigger evaluation from the run-mode menu — useful when the
// auto-eval threshold hasn't been hit but the user wants to score the
// turn anyway.
//
// Reuses evaluateAllApplicable so all the existing wiring (deterministic
// checks, judge calls, finding aggregation) flows through unchanged.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRun, getEventsForRun } from "@/lib/traces";
import { evaluateAllApplicable } from "@/lib/rubrics";
import { pool } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const run = await getRun(params.id, user.id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  // Pull the user message + assistant response from the thread to feed
  // the eval. We use the run.messageId to find the assistant message,
  // and look back one user message before it.
  const events = await getEventsForRun(params.id, user.id);

  const msgs = await pool().query(
    `SELECT * FROM messages WHERE id=$1 OR ("threadId"=$2 AND "createdAt" < (SELECT "createdAt" FROM messages WHERE id=$1))
     ORDER BY "createdAt" DESC LIMIT 4`,
    [run.messageId, run.threadId],
  );
  const assistantMsg = msgs.rows.find((m: any) => m.id === run.messageId);
  const userMsg = msgs.rows.filter((m: any) => m.role === "user")[0];

  const toolCalls = (assistantMsg?.toolCalls ? JSON.parse(assistantMsg.toolCalls) : [])
    .map((t: any) => ({ name: t.name, args: t.args, result: t.result, success: !t.result?.startsWith?.("Tool error:") }));

  const results = await evaluateAllApplicable({
    userId: user.id,
    agentId: run.agentId || null,
    runId: params.id,
    userMessage: userMsg?.content || "",
    agentResponse: assistantMsg?.content || "",
    systemBlocksText: "", // not reconstructed for manual eval — rubrics requiring this gracefully skip
    toolCalls,
    traceEvents: events,
    workingDocSections: undefined,
    run: {
      budgetCapCredits: (run as any).budgetCapCredits,
      spentCredits: (run as any).spentCredits || run.totalCostCredits || 0,
    },
    artifactIds: [],
  });

  await audit({
    userId: user.id,
    action: "rubric.eval_manual",
    resource: params.id,
    result: "success",
    metadata: { rubricCount: results.length, agentId: run.agentId || null },
    ...auditFromRequest(req),
  });

  return NextResponse.json({
    runId: params.id,
    results: results.map(r => ({
      rubricId: r.rubricId,
      passed: r.passed,
      overallScore: r.overallScore,
      failedRequired: r.failedRequired,
      findings: r.findings.map((f: any) => ({
        criterion: f.criterion?.name || f.name,
        passed: f.passed,
        score: f.score,
        message: f.message,
      })),
    })),
  });
}
