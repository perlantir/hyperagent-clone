// P66d — POST /api/codex/runs/:runId/cancel
//
// Server-authoritative cancellation. Marks the run cancelling and
// enqueues a `cancel` dispatch packet for the companion to pick up.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { enforceCsrf } from "@/lib/codex/origin-guard";
import { getRun, transitionRunState } from "@/lib/codex/runs-store";
import { enqueueDispatch } from "@/lib/codex/companions-store";
import { relayDispatch, RelayNotConfiguredError } from "@/lib/codex/relay-client";
import { emitAuditLog } from "@/lib/codex/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { runId: string } }) {
  const csrf = enforceCsrf(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);
  const run = await getRun({ runId: params.runId, userId: user.id });
  if (!run) return jsonNoStore({ error: "not_found" }, 404);
  if (!run.companionId) return jsonNoStore({ error: "no_companion" }, 400);

  const ok = await transitionRunState({
    runId: run.runId,
    expectedFrom: ["queued", "dispatched", "running", "approval_pending"],
    to: "cancelling",
  });
  if (!ok) {
    return jsonNoStore({ error: "cannot_cancel", state: run.state }, 409);
  }
  await enqueueDispatch({
    runId: run.runId,
    companionId: run.companionId,
    direction: "to_companion",
    kind: "cancel",
    payload: { reason: "user_cancel" },
  });
  try {
    await relayDispatch({
      runId: run.runId,
      companionId: run.companionId,
      kind: "cancel",
      payload: { reason: "user_cancel" },
    });
  } catch (e) {
    if (!(e instanceof RelayNotConfiguredError)) {
      // best-effort; queue row is the source of truth
    }
  }
  await emitAuditLog({
    userId: user.id, runId: run.runId, providerMode: run.providerMode,
    event: "run/cancelled", severity: "info",
    details: { from: run.state, source: "user" },
  });
  return jsonNoStore({ ok: true });
}

function jsonNoStore(body: any, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
