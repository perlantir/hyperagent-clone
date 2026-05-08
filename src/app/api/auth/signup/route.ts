import { NextResponse } from "next/server";
import { getUserByEmail, createUser, createAgent } from "@/lib/db";
import { setSessionCookie } from "@/lib/auth";

export async function POST(req: Request) {
  const { email, password, name } = await req.json().catch(() => ({}));
  if (!email || !password || !name) return NextResponse.json({ error: "email, password, name required" }, { status: 400 });
  if (getUserByEmail(email)) return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  const user = createUser(email, password, name);
  // Seed a default agent
  createAgent({
    userId: user.id,
    name: "General assistant",
    icon: "G",
    color: "orange",
    description: "Default agent. Helpful, careful, transparent about uncertainty.",
    systemPrompt: "You are a helpful AI assistant. Be concise and accurate. When you do not know something, say so. Use tools when relevant.",
    tools: ["web_search", "generate_artifact"],
  });
  setSessionCookie(user.id);
  return NextResponse.json({ id: user.id, email: user.email, name: user.name });
}
