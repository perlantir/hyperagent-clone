// Stripe webhook (P21). Verifies signature, credits the account on success.
// P29 — wrapped in withIdempotency by event.id so Stripe retries don't double-credit.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { addCredits } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";

export const runtime = "nodejs";

function verifyStripe(payload: string, sigHeader: string | null, secret: string): boolean {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map(p => p.split("=")));
  const ts = parts.t; const v1 = parts.v1;
  if (!ts || !v1) return false;
  const signed = crypto.createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(signed), Buffer.from(v1)); } catch { return false; }
}

export async function POST(req: Request) {
  const body = await req.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (secret && !verifyStripe(body, req.headers.get("stripe-signature"), secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
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
      try { await addCredits(userId, credits, `Stripe top-up (${sess.id})`, sess.id); }
      catch (e) { console.error("[stripe webhook]", e); throw e; }  // throw so idempotency marks failed
    }
  }
  return NextResponse.json({ ok: true });
}
