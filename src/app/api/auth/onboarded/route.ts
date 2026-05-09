// P30 — Mark the current user as onboarded.
//   POST /api/auth/onboarded → sets users.onboardedAt = now()
//
// Idempotent. The DB UPDATE has a "WHERE onboardedAt IS NULL" guard so
// double-clicks or accidental re-fires don't reset the timestamp.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { markUserOnboarded } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await markUserOnboarded(user.id);
  return NextResponse.json({ ok: true });
}
