// P66d — POST /api/codex/runs/:runId/approvals/:approvalId
//
// Server-authoritative approval decision. ChatView's approval card
// posts here (companion mode) instead of calling the WS directly.
//
// Body: { decision: "approved" | "approvedForSession" | "denied" }
//
// Behavior:
//   1. Atomically transition the approval row pending → decided.
//   2. Enqueue an `approval_decision` dispatch packet for the
//      companion to pick up (which it forwards to codex's pending
//      JSON-RPC server-request id).
//   3. Audit emit.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { enforceCsrf } from "@/lib/codex/origin-guard";
import { decideApproval } from "@/lib/codex/runs-store";
import { enqueueDispatch } from "@/lib/codex/companions-store";
import { relayDispatch, RelayNotConfiguredError } from "@/lib/codex/relay-client";
import { emitAuditLog } from "@/lib/codex/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { runId: string; approvalId: string } },
) {
  const csrf = enforceCsrf(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); }
  catch { return jsonNoStore({ error: "invalid_json" }, 400); }
  const decision = String(body?.decision ?? "");
  if (decision !== "approved" && decision !== "approvedForSession" && decision !== "denied") {
    return jsonNoStore({ error: "bad_decision" }, 400);
  }

  const r = await decideApproval({
    approvalId: params.approvalId,
    userId: user.id,
    decision: decision as any,
    source: "web",
  });
  if (!r.ok) {
    const status = r.reason === "not_found" ? 404
                 : r.reason === "wrong_user" ? 403
                 : r.reason === "expired" || r.reason === "already_decided" ? 410
                 : 400;
    return jsonNoStore({ error: r.reason }, status);
  }
  // Enqueue + dispatch decision to companion.
  if (r.row.companionId) {
    const dispatchPayload = {
      approvalId: params.approvalId,
      decision,
      runId: params.runId,
    };
    await enqueueDispatch({
      runId: params.runId,
      companionId: r.row.companionId,
      direction: "to_companion",
      kind: "approval_decision",
      payload: dispatchPayload,
    });
    try {
      await relayDispatch({
        runId: params.runId,
        companionId: r.row.companionId,
        kind: "approval_decision",
        payload: dispatchPayload,
      });
    } catch (e) {
      if (!(e instanceof RelayNotConfiguredError)) {
        // best effort; queue row catches up on companion reconnect
      }
    }
  }
  await emitAuditLog({
    userId: user.id,
    runId: params.runId,
    companionId: r.row.companionId,
    providerMode: "codexChatGPTCompanion",
    event: "approval/decided",
    severity: "info",
    details: { kind: r.row.kind, decision },
  });
  return jsonNoStore({ ok: true, decidedAt: r.row.decidedAt });
}

function jsonNoStore(body: any, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
