// Stripe webhook. Verifies signature, credits the account on success.
// P29 — wrapped in withIdempotency by event.id so Stripe retries don't double-credit.
// P33a — uses shared verifyWebhookSignature helper + audit log.

import { NextResponse } from "next/server";
import { addCredits } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";
import { verifyWebhookSignature } from "@/lib/security";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (secret) {
    const verify = verifyWebhookSignature("stripe", body, req.headers, secret);
    if (!verify.valid) {
      await audit({
        userId: null, action: "webhook.rejected", resource: "stripe",
        result: "denied", metadata: { reason: verify.reason },
        ...auditFromRequest(req),
      });
      return NextResponse.json({ error: "bad signature" }, { status: 401 });
    }
  }
  let event: any;
  try { event = JSON.parse(body); } catch { return NextResponse.json({ error: "bad body" }, { status: 400 }); }

  // Stripe retries failed webhooks for up to 3 days. Without this, a single
  // checkout.session.completed event can fire 5+ times and credit the user
  // every time. event.id is unique and stable across retries.
  if (!event?.id) {
    // Some test events lack id; fall through to non-idempotent path.
    return await processEventNonIdempotent(event);
  }

  const { result, replayed } = await withIdempotency(
    { namespace: "stripe_webhook", key: event.id, ttlSeconds: 7 * 24 * 3600 },
    async () => processEventNonIdempotent(event),
  );

  // 200 OK regardless — replays return cached success.
  return NextResponse.json({ ok: true, replayed, eventId: event.id });
}

async function processEventNonIdempotent(event: any): Promise<NextResponse> {
  if (event?.type === "checkout.session.completed") {
    const sess = event?.data?.object;
    const userId = sess?.metadata?.userId || sess?.client_reference_id;
    const credits = parseInt(sess?.metadata?.credits || "0", 10);
    if (userId && credits > 0 && sess?.id) {
      try {
        await addCredits(userId, credits, `Stripe top-up (${sess.id})`, sess.id);
        await audit({
          userId, action: "billing.topup", resource: `stripe_event:${event.id}`,
          result: "success", metadata: { credits, sessionId: sess.id },
        });
      } catch (e) {
        await audit({
          userId, action: "billing.failed", resource: `stripe_event:${event.id}`,
          result: "failure", metadata: { error: (e as any)?.message },
        });
        throw e;  // throw so idempotency marks failed
      }
    }
  }
  return NextResponse.json({ ok: true });
}
