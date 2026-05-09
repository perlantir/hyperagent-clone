// P59 — POST a decision for a pending Codex approval.
//
//   POST /api/codex/approval/<approvalId>
//   Body: { decision: "accept" | "acceptForSession" | "decline" | "cancel" }
//
// Updates the codex_approvals row. The chat lambda's poll loop picks up
// the change and forwards approval/respond to the bridge over the
// still-open WebSocket. Ownership-scoped so only the user who owns the
// thread can resolve the approval.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { submitDecision, type ApprovalDecision } from "@/lib/codex/approvals-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED: ApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const decision = body?.decision;
  if (!ALLOWED.includes(decision)) {
    return NextResponse.json({ error: `decision must be one of: ${ALLOWED.join(", ")}` }, { status: 400 });
  }
  const ok = await submitDecision(params.id, user.id, decision);
  if (!ok) {
    return NextResponse.json(
      { error: "approval not found, already decided, or not owned by this user" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
