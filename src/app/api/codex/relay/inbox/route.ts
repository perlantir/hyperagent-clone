// P66c — POST /api/codex/relay/inbox
//
// Relay → Vercel callback. The relay forwards companion-emitted
// events here for ingest. Auth is HMAC over the raw request body
// using `RELAY_SHARED_SECRET`.
//
// Body shape (from the relay):
//   {
//     companionId: string,
//     userId:      string,
//     batch: Array<
//       | { kind: "event", source, eventType, sequence, runId, idempotencyKey, emittedAt, payload }
//       | { kind: "dispatch_ack", dispatchId: number }
//     >,
//     ts: number
//   }
//
// We reuse:
//   - persistMirroredEvents (P65) for the actual events store
//   - markDispatchDelivered  (P66c) for dispatch acks

import { NextResponse } from "next/server";
import { verifyRelayHmac } from "@/lib/codex/relay-client";
import { persistMirroredEvents } from "@/lib/codex/event-mirror";
import { markDispatchDelivered, getCompanion } from "@/lib/codex/companions-store";
import { emitAuditLog } from "@/lib/codex/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  // We need the raw body (not parsed JSON) for the HMAC check.
  const rawBody = await req.text();
  const sig = req.headers.get("x-relay-signature");
  if (!verifyRelayHmac(rawBody, sig)) {
    return jsonNoStore({ error: "bad_signature" }, 401);
  }
  let body: any;
  try { body = JSON.parse(rawBody); }
  catch { return jsonNoStore({ error: "bad_json" }, 400); }

  const { companionId, batch } = body || {};
  if (typeof companionId !== "string" || !Array.isArray(batch)) {
    return jsonNoStore({ error: "bad_params" }, 400);
  }
  const companion = await getCompanion(companionId);
  if (!companion || companion.revokedAt) {
    return jsonNoStore({ error: "unknown_or_revoked_companion" }, 404);
  }

  // Split entries into events (run-mirrored) and dispatch acks.
  let dispatchAcks = 0;
  const eventBuckets = new Map<string, any[]>();
  for (const entry of batch) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.kind === "dispatch_ack" && typeof entry.dispatchId === "number") {
      const ok = await markDispatchDelivered({ id: entry.dispatchId });
      if (ok) dispatchAcks++;
      continue;
    }
    if (entry.kind === "event" && typeof entry.runId === "string") {
      const bucket = eventBuckets.get(entry.runId) || [];
      bucket.push({
        source: entry.source || "companion",
        sequence: typeof entry.sequence === "number" ? entry.sequence : 0,
        eventType: String(entry.eventType || "unknown"),
        emittedAt: typeof entry.emittedAt === "number" ? entry.emittedAt : Date.now(),
        idempotencyKey: String(entry.idempotencyKey || ""),
        payload: entry.payload ?? {},
      });
      eventBuckets.set(entry.runId, bucket);
    }
  }

  let totalInserted = 0;
  let totalTruncated = 0;
  for (const [runId, events] of eventBuckets) {
    const r = await persistMirroredEvents({
      runId,
      userId: companion.userId,
      orgId: companion.orgId,
      agentId: null,
      threadId: "",
      pairSessionId: null,
      providerMode: "codexChatGPTCompanion",
    }, events);
    totalInserted += r.inserted;
    totalTruncated += r.truncated;
  }

  await emitAuditLog({
    userId: companion.userId,
    orgId: companion.orgId,
    companionId,
    providerMode: "codexChatGPTCompanion",
    event: "run/dispatched", // generic activity ping; per-event audit happens elsewhere
    severity: "info",
    details: { dispatchAcks, eventCount: totalInserted, truncated: totalTruncated },
  });

  return jsonNoStore({ ok: true, dispatchAcks, eventsInserted: totalInserted, truncated: totalTruncated });
}

function jsonNoStore(body: any, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
