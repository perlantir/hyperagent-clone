// Real Stripe Checkout (P21). Creates a Checkout session and returns the URL.
// Stripe webhook (/api/stripe/webhook) credits the account when payment completes.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { PACKAGES } from "@/lib/credits";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { packageId } = await req.json().catch(() => ({}));
  const pkg = PACKAGES.find(p => p.id === packageId);
  if (!pkg) return NextResponse.json({ error: "unknown package" }, { status: 400 });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    // Dev fallback — credit immediately if no Stripe key (so settings still work)
    const { topUp } = await import("@/lib/credits");
    await topUp(user.id, pkg.credits, `Top-up (no-Stripe dev): ${pkg.name}`);
    return NextResponse.json({ ok: true, dev: true, added: pkg.credits });
  }

  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", `${origin}/billing?topup=success`);
  params.set("cancel_url", `${origin}/billing?topup=cancel`);
  params.set("client_reference_id", user.id);
  params.append("metadata[userId]", user.id);
  params.append("metadata[packageId]", pkg.id);
  params.append("metadata[credits]", String(pkg.credits));
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][product_data][name]", `${pkg.name} pack — ${pkg.credits.toLocaleString()} credits`);
  params.append("line_items[0][price_data][unit_amount]", String(pkg.priceUsd * 100));
  params.append("line_items[0][quantity]", "1");

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok) return NextResponse.json({ error: "Stripe error: " + await r.text() }, { status: 500 });
  const session = await r.json();
  return NextResponse.json({ ok: true, url: session.url, sessionId: session.id });
}
