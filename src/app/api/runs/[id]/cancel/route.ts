// P32 — Cancel an active run.
//   POST /api/runs/{id}/cancel → { ok: true } or { error }
//
// Cooperative cancel: marks trace_runs.status = 'cancelled'. The chat
// loop reads this status between iterations and exits early. This will
// not interrupt an in-flight LLM stream — the next iteration boundary is
// the abort point.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { cancelActiveRun } from "@/lib/command-center";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const ok = await cancelActiveRun(params.id, user.id);
  await audit({
    userId: user.id, action: "agent_run.cancelled", resource: params.id,
    result: ok ? "success" : "failure",
    metadata: ok ? { source: "command_center" } : { reason: "run not running or not owned" },
    ...auditFromRequest(req),
  });

  if (!ok) {
    return NextResponse.json(
      { error: "run not found, not yours, or already finished" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
