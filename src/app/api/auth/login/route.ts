import { NextResponse } from "next/server";
import { getUserByEmail, verifyPassword } from "@/lib/db";
import { setSessionCookie } from "@/lib/auth";
import { audit, auditFromRequest } from "@/lib/audit";
import { enforceRateLimit, RateLimitError } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const { email, password } = await req.json().catch(() => ({}));
  if (!email || !password) return NextResponse.json({ error: "email and password required" }, { status: 400 });

  // P33a — rate-limit login attempts per email to slow brute-force attacks.
  // 10 attempts per 5 minutes is generous for legitimate typo recovery; abuse
  // looks like 50+ attempts in a minute.
  try {
    await enforceRateLimit({
      userId: `login:${email.toLowerCase()}`, namespace: "auth_login",
      maxRequests: 10, windowMs: 5 * 60_000,
    });
  } catch (e) {
    if (e instanceof RateLimitError) {
      await audit({
        userId: null, action: "rate_limit.blocked", resource: `email:${email}`,
        result: "denied", metadata: { surface: "login" }, ...auditFromRequest(req),
      });
      return NextResponse.json(
        { error: "too many attempts, try again later" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } },
      );
    }
    throw e;
  }

  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    await audit({
      userId: user?.id || null, action: "auth.failed", resource: `email:${email}`,
      result: "denied", ...auditFromRequest(req),
    });
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  await setSessionCookie(user.id);
  await audit({ userId: user.id, action: "auth.login", result: "success", ...auditFromRequest(req) });
  return NextResponse.json({ id: user.id, email: user.email, name: user.name });
}
