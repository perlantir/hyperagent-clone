// P65 — POST /api/codex/run-ticket
//
// Browser asks for a server-issued run ticket before starting a
// companion-driven Codex turn. The ticket binds:
//
//   - userId, threadId, agentId
//   - providerMode (codexChatGPTCompanion in P65)
//   - pairSessionId of the companion this run targets
//   - approval policy
//   - budget cap (advisory in companion mode)
//   - traceTarget (always our /api/codex/events)
//   - 30-min expiry, signed with the server-side HMAC key
//
// The browser hands the ticket to the companion when starting a turn,
// and the companion includes the ticket in every event mirrored back
// to /api/codex/events. The events route verifies the ticket so a
// stale or foreign event can't poison a run's trace.
//
// Body: { threadId, agentId?, providerMode, pairSessionId? }
// Returns: { ticket: { payload, sig }, encoded, payload: <decoded view> }

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { issueRunTicket, encodeRunTicket } from "@/lib/codex/run-ticket";
import { getPairStatus } from "@/lib/codex/pair-store";
import { enforceCsrf } from "@/lib/codex/origin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const csrf = enforceCsrf(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "invalid_json" }, 400);
  }
  const threadId = String(body?.threadId ?? "");
  const agentId = body?.agentId ? String(body.agentId) : null;
  const providerMode = String(body?.providerMode ?? "");
  const pairSessionId = body?.pairSessionId ? String(body.pairSessionId) : null;
  if (!threadId) return jsonNoStore({ error: "missing_thread_id" }, 400);
  if (
    providerMode !== "codexChatGPTCompanion" &&
    providerMode !== "codexChatGPTLocal" &&
    providerMode !== "codexChatGPTBridge"
  ) {
    return jsonNoStore({ error: "unsupported_provider_mode" }, 400);
  }

  // For companion mode, the pair session must exist, be online, and
  // belong to this user. This catches a user who tries to issue a
  // ticket against a stale session.
  if (providerMode === "codexChatGPTCompanion") {
    if (!pairSessionId) return jsonNoStore({ error: "missing_pair_session_id" }, 400);
    try {
      const view = await getPairStatus({ userId: user.id, sessionId: pairSessionId });
      if (view.status !== "claimed") {
        return jsonNoStore({ error: "pair_session_not_claimed", status: view.status }, 400);
      }
      if (!view.online) {
        return jsonNoStore({ error: "pair_session_offline" }, 400);
      }
    } catch {
      return jsonNoStore({ error: "pair_session_not_found" }, 404);
    }
  }

  const { ticket, payload } = issueRunTicket({
    userId: user.id,
    orgId: (user as any).orgId ?? null,
    agentId,
    threadId,
    providerMode: providerMode as any,
    pairSessionId,
  });

  return jsonNoStore({
    ticket,
    encoded: encodeRunTicket(ticket),
    payload: {
      runId: payload.runId,
      providerMode: payload.providerMode,
      pairSessionId: payload.pairSessionId,
      approvalPolicy: payload.approvalPolicy,
      budgetEnforcement: payload.budgetEnforcement,
      traceTarget: payload.traceTarget,
      expiresAt: payload.expiresAt,
      iat: payload.iat,
    },
  });
}

function jsonNoStore(body: any, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, max-age=0",
    },
  });
}
