// P65 — POST /api/codex/events
//
// Sink for events mirrored from the Codex Companion (and the browser
// driving it). The route verifies the run ticket, redacts the
// payloads, and persists each event idempotently into codex_run_events.
//
// Body: {
//   ticket: { payload, sig } | string,
//   events: Array<{
//     source: "browser" | "companion" | "codex",
//     sequence: number,        // monotonic per source
//     eventType: string,
//     emittedAt: number,       // unix ms (emitter)
//     idempotencyKey: string,
//     payload: any,            // already-redacted JSON; we redact again
//   }>
// }
//
// Returns: { ok: true, runId, inserted, duplicates, outOfOrder, invalid }
//
// AUTH: cookie-bearing if available (browser path), but the AUTHORITY
// for accepting an event is the run ticket signature + expiry. We
// match userId via cookie when present and reject if it doesn't agree
// with the ticket.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { decodeRunTicket, verifyRunTicket } from "@/lib/codex/run-ticket";
import { persistMirroredEvents } from "@/lib/codex/event-mirror";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_EVENTS_PER_REQUEST = 200;

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "invalid_json" }, 400);
  }

  // Accept ticket as object OR encoded "<payload>.<sig>" string.
  let ticket: any = body?.ticket;
  if (typeof ticket === "string") ticket = decodeRunTicket(ticket);
  if (!ticket || typeof ticket !== "object") {
    return jsonNoStore({ error: "missing_ticket" }, 400);
  }
  const verified = verifyRunTicket(ticket);
  if (!verified.ok) {
    return jsonNoStore({ error: "invalid_ticket", reason: verified.reason }, 401);
  }

  // Cookie-based user check when present. Companion (no cookie) skips
  // this; the ticket signature is the auth.
  const user = await getCurrentUser().catch(() => null);
  if (user && user.id !== verified.payload.userId) {
    return jsonNoStore({ error: "ticket_user_mismatch" }, 403);
  }

  const events = Array.isArray(body?.events) ? body.events : [];
  if (events.length === 0) {
    return jsonNoStore({ ok: true, runId: verified.payload.runId, inserted: 0, duplicates: 0, outOfOrder: 0, invalid: 0 });
  }
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    return jsonNoStore(
      { error: "too_many_events", limit: MAX_EVENTS_PER_REQUEST },
      413,
    );
  }

  const result = await persistMirroredEvents(
    {
      runId: verified.payload.runId,
      userId: verified.payload.userId,
      orgId: verified.payload.orgId,
      agentId: verified.payload.agentId,
      threadId: verified.payload.threadId,
      pairSessionId: verified.payload.pairSessionId,
      providerMode: verified.payload.providerMode,
    },
    events,
  );

  return jsonNoStore({ ok: true, runId: verified.payload.runId, ...result });
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
