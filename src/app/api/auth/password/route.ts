// P42 — Change password.
//
//   POST /api/auth/password  body: { current, next }
//   → { ok: true }
//
// Verifies the current password before accepting the new one. Rate-
// limited per user (5 attempts per 15 minutes) to slow down credential
// stuffing if a session token is leaked.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { pool, hashPassword, verifyPassword } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";
import { enforceRateLimit, RateLimitError } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    await enforceRateLimit({ userId: user.id, namespace: "auth_password_change", maxRequests: 5, windowMs: 15 * 60_000 });
  } catch (e) {
    if (e instanceof RateLimitError) {
      await audit({ userId: user.id, action: "rate_limit.blocked", resource: "auth_password_change", result: "denied", ...auditFromRequest(req) });
      return NextResponse.json({ error: "too many password change attempts" }, { status: 429 });
    }
    throw e;
  }

  const { current, next } = await req.json().catch(() => ({}));
  if (typeof current !== "string" || typeof next !== "string") {
    return NextResponse.json({ error: "current + next required" }, { status: 400 });
  }
  if (next.length < 8) {
    return NextResponse.json({ error: "new password must be at least 8 characters" }, { status: 400 });
  }

  const r = await pool().query(`SELECT "passwordHash" FROM users WHERE id=$1`, [user.id]);
  if (!r.rows[0]) return NextResponse.json({ error: "user not found" }, { status: 404 });
  if (!verifyPassword(current, r.rows[0].passwordHash)) {
    await audit({
      userId: user.id, action: "auth.failed", resource: "password-change",
      result: "failure", metadata: { reason: "wrong current password" },
      ...auditFromRequest(req),
    });
    return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });
  }

  await pool().query(`UPDATE users SET "passwordHash"=$1 WHERE id=$2`, [hashPassword(next), user.id]);
  await audit({
    userId: user.id, action: "secret.set", resource: "password",
    result: "success", metadata: { source: "password-change" },
    ...auditFromRequest(req),
  });
  return NextResponse.json({ ok: true });
}
