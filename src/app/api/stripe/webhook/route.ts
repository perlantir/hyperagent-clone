// Stripe webhook (P21). Verifies signature, credits the account on success.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { addCredits } from "@/lib/db";

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
  const event = JSON.parse(body);
  if (event.type === "checkout.session.completed") {
    const sess = event.data.object;
    const userId = sess.metadata?.userId || sess.client_reference_id;
    const credits = parseInt(sess.metadata?.credits || "0", 10);
    if (userId && credits > 0) {
      await addCredits(userId, credits, `Stripe top-up (${sess.id})`, sess.id);
    }
  }
  return NextResponse.json({ ok: true });
}
