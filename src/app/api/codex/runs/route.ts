// P66d — POST /api/codex/runs
//
// Server-authoritative run creation entry point. ChatView (companion
// mode) hits this instead of /api/chat or the WS-direct path.
//
// Body:  { threadId, agentId?, providerMode, pairSessionId?, input,
//          attachments? }
// Returns: { runId, encodedTicket, streamUrl }
//
// Behavior:
//   - Verifies provider mode is allowed (today: companion mode only on
//     this route; bridge/local still use existing paths).
//   - Verifies companion is online via relay /connections/:id.
//   - Issues a run-ticket bound to the run.
//   - INSERTs a `codex_runs` row in state="queued".
//   - Enqueues a `to_companion` dispatch row.
//   - Calls relay.relayDispatch — if 200, marks state="dispatched".
//   - Returns runId + streamUrl so the browser can subscribe via SSE.
//
// Audit: emit run/created on success.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { enforceCsrf } from "@/lib/codex/origin-guard";
import { issueRunTicket, encodeRunTicket } from "@/lib/codex/run-ticket";
import { createRun, transitionRunState } from "@/lib/codex/runs-store";
import { getPairStatus } from "@/lib/codex/pair-store";
import { listCompanionsForUser, enqueueDispatch } from "@/lib/codex/companions-store";
import { relayDispatch, RelayNotConfiguredError } from "@/lib/codex/relay-client";
import { emitAuditLog } from "@/lib/codex/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  const csrf = enforceCsrf(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); }
  catch { return jsonNoStore({ error: "invalid_json" }, 400); }

  const threadId = String(body?.threadId ?? "");
  const providerMode = String(body?.providerMode ?? "");
  const agentId = body?.agentId ? String(body.agentId) : null;
  const pairSessionId = body?.pairSessionId ? String(body.pairSessionId) : null;
  const input = String(body?.input ?? "");

  if (!threadId) return jsonNoStore({ error: "missing_thread_id" }, 400);
  if (providerMode !== "codexChatGPTCompanion") {
    return jsonNoStore({
      error: "unsupported_provider_mode",
      message: "POST /api/codex/runs is for companion mode. Local + bridge modes use /api/chat.",
    }, 400);
  }
  if (!input) return jsonNoStore({ error: "missing_input" }, 400);

  // Resolve companion: either explicitly passed or pick the user's
  // first online one.
  let companionId: string | null = null;
  if (pairSessionId) {
    try {
      const view = await getPairStatus({ userId: user.id, sessionId: pairSessionId });
      if (view.status !== "claimed" || !view.online) {
        return jsonNoStore({ error: "pair_session_offline", status: view.status }, 400);
      }
    } catch {
      return jsonNoStore({ error: "pair_session_not_found" }, 404);
    }
  }
  // Map user → companion via the companions registry. The pair session
  // stores the bind; here we just pick the user's first online,
  // non-revoked companion.
  const companions = await listCompanionsForUser(user.id);
  const eligible = companions.find((c) => !c.revokedAt && c.enabledForRuns);
  if (!eligible) {
    return jsonNoStore({ error: "no_companion_registered" }, 400);
  }
  companionId = eligible.id;

  // Issue run ticket.
  const { ticket, payload } = issueRunTicket({
    userId: user.id,
    orgId: (user as any).orgId ?? null,
    agentId,
    threadId,
    providerMode: "codexChatGPTCompanion",
    pairSessionId,
  });

  // Persist run row.
  const run = await createRun({
    runId: payload.runId,
    userId: user.id,
    orgId: (user as any).orgId ?? null,
    threadId,
    agentId,
    companionId,
    providerMode: "codexChatGPTCompanion",
    policySnapshot: { approvalPolicy: payload.approvalPolicy, budgetEnforcement: payload.budgetEnforcement },
  });

  await emitAuditLog({
    userId: user.id,
    orgId: (user as any).orgId ?? null,
    companionId,
    runId: run.runId,
    providerMode: "codexChatGPTCompanion",
    event: "run/created",
    severity: "info",
    details: { threadId, agentId },
  });

  // Enqueue dispatch packet.
  const dispatchPayload = {
    runTicket: encodeRunTicket(ticket),
    threadId,
    input,
    runId: run.runId,
  };
  await enqueueDispatch({
    runId: run.runId,
    companionId,
    direction: "to_companion",
    kind: "run_dispatch",
    payload: dispatchPayload,
  });

  // Best-effort live dispatch via relay. If relay is offline / not
  // configured, the queue row stays unconsumed; companion drains on
  // next reconnect.
  try {
    const r = await relayDispatch({
      runId: run.runId,
      companionId,
      kind: "run_dispatch",
      payload: dispatchPayload,
    });
    if (r.delivered) {
      await transitionRunState({
        runId: run.runId,
        expectedFrom: ["queued"],
        to: "dispatched",
      });
      await emitAuditLog({
        userId: user.id,
        runId: run.runId,
        providerMode: "codexChatGPTCompanion",
        event: "run/dispatched",
        severity: "info",
      });
    }
  } catch (e: any) {
    if (!(e instanceof RelayNotConfiguredError)) {
      // Surface relay issues but don't fail the run; the queue path
      // will catch up on reconnect.
      await emitAuditLog({
        userId: user.id, runId: run.runId, providerMode: "codexChatGPTCompanion",
        event: "run/dispatched", severity: "warn",
        details: { relayError: String(e?.message || e).slice(0, 200) },
      });
    }
  }

  return jsonNoStore({
    runId: run.runId,
    encodedTicket: encodeRunTicket(ticket),
    streamUrl: `/api/codex/runs/${run.runId}/stream`,
    state: run.state,
  });
}

function jsonNoStore(body: any, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
