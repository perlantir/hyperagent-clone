import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { topUp, PACKAGES } from "@/lib/credits";

// In production this would integrate with Stripe Checkout. For the prototype
// we just credit the account on POST and assume payment succeeded.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { packageId } = await req.json().catch(() => ({}));
  const pkg = PACKAGES.find(p => p.id === packageId);
  if (!pkg) return NextResponse.json({ error: "unknown package" }, { status: 400 });
  topUp(user.id, pkg.credits, `Top-up: ${pkg.name} ($${pkg.priceUsd})`);
  return NextResponse.json({ ok: true, added: pkg.credits });
}
