import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listAgents, createAgent } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ agents: listAgents(user.id) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const a = createAgent({
    userId: user.id,
    name: body.name || "Untitled Agent",
    icon: (body.icon || (body.name?.[0] || "A").toUpperCase()).slice(0, 1),
    color: body.color || "orange",
    description: body.description || "",
    systemPrompt: body.systemPrompt || "You are a helpful AI assistant.",
    tools: Array.isArray(body.tools) ? body.tools : ["web_search", "generate_artifact"],
  });
  return NextResponse.json({ agent: a });
}
