import { NextResponse } from "next/server";
import { getUserByEmail, createUser, createAgent } from "@/lib/db";
import { setSessionCookie } from "@/lib/auth";
import { audit, auditFromRequest } from "@/lib/audit";
import { enforceRateLimit, RateLimitError, ipKeyFromRequest } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const { email, password, name } = await req.json().catch(() => ({}));
  if (!email || !password || !name) return NextResponse.json({ error: "email, password, name required" }, { status: 400 });

  // P33a — IP-based rate limit on signup. One IP shouldn't create many
  // accounts in quick succession (spam/abuse vector). 5 per hour is
  // generous for legitimate use (multi-team trial accounts) but blocks
  // bot-driven signup floods.
  const ipKey = ipKeyFromRequest(req);
  try {
    await enforceRateLimit({ userId: ipKey, namespace: "auth_signup_ip", maxRequests: 5, windowMs: 60 * 60_000 });
  } catch (e) {
    if (e instanceof RateLimitError) {
      await audit({
        userId: null, action: "rate_limit.blocked", resource: ipKey,
        result: "denied", metadata: { surface: "signup", limit: 5, windowMs: 3600_000 },
        ...auditFromRequest(req),
      });
      return NextResponse.json(
        { error: "too many signup attempts from this IP, try again later" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } },
      );
    }
    throw e;
  }

  if (await getUserByEmail(email)) {
    await audit({
      userId: null, action: "auth.signup", resource: `email:${email}`,
      result: "failure", metadata: { reason: "email already in use" }, ...auditFromRequest(req),
    });
    return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  }
  const user = await createUser(email, password, name);
  // Seed a default agent
  await createAgent({
    userId: user.id,
    name: "General assistant",
    icon: "G",
    color: "orange",
    description: "Default agent. Helpful, careful, transparent about uncertainty.",
    systemPrompt: "You are a helpful AI assistant. Be concise and accurate. When you do not know something, say so. Use tools when relevant.",
    tools: (await import("@/lib/tools")).DEFAULT_AGENT_TOOLS,
  });
  await setSessionCookie(user.id);
  await audit({ userId: user.id, action: "auth.signup", result: "success", ...auditFromRequest(req) });
  return NextResponse.json({ id: user.id, email: user.email, name: user.name });
}
