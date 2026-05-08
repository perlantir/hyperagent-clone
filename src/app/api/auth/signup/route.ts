import { NextResponse } from "next/server";
import { getUserByEmail, createUser, createAgent } from "@/lib/db";
import { setSessionCookie } from "@/lib/auth";
import { audit, auditFromRequest } from "@/lib/audit";

export async function POST(req: Request) {
  const { email, password, name } = await req.json().catch(() => ({}));
  if (!email || !password || !name) return NextResponse.json({ error: "email, password, name required" }, { status: 400 });
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
