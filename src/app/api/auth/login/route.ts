import { NextResponse } from "next/server";
import { getUserByEmail, verifyPassword } from "@/lib/db";
import { setSessionCookie } from "@/lib/auth";
import { audit, auditFromRequest } from "@/lib/audit";
import { enforceRateLimit, RateLimitError, ipKeyFromRequest } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const { email, password } = await req.json().catch(() => ({}));
  if (!email || !password) return NextResponse.json({ error: "email and password required" }, { status: 400 });

  // P33a — layered rate limits. Per-email catches direct brute-force on a
  // specific account; per-IP catches credential stuffing rotating across
  // many emails from the same source. Both must pass.
  const emailKey = `login:${email.toLowerCase()}`;
  const ipKey = ipKeyFromRequest(req);
  const limits: Array<{ key: string; namespace: string; max: number; reason: string }> = [
    { key: emailKey, namespace: "auth_login_email", max: 10, reason: "email" },
    { key: ipKey,    namespace: "auth_login_ip",    max: 30, reason: "ip" },
  ];
  for (const lim of limits) {
    try {
      await enforceRateLimit({ userId: lim.key, namespace: lim.namespace, maxRequests: lim.max, windowMs: 5 * 60_000 });
    } catch (e) {
      if (e instanceof RateLimitError) {
        await audit({
          userId: null, action: "rate_limit.blocked",
          resource: lim.reason === "email" ? `email:${email}` : ipKey,
          result: "denied",
          metadata: { surface: "login", reason: lim.reason, limit: lim.max },
          ...auditFromRequest(req),
        });
        return NextResponse.json(
          { error: "too many attempts, try again later" },
          { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } },
        );
      }
      throw e;
    }
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
