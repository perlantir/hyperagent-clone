// P35 — Promote a thread into a saved agent.
//
//   POST /api/agents/from-thread
//   Body: { threadId: string, name: string, description?: string,
//           icon?: string, color?: string }
//   → { agent }
//
// The new agent inherits the thread's currently-bound agent (if any) as
// its system prompt + tools template; otherwise it gets the platform
// defaults. The first-version snapshot is captured by the existing
// agent-versions hook on PATCH, but since this is a fresh INSERT we don't
// run that here — the agent starts at v0 (no edits yet), which the UI
// renders correctly.
//
// Why not `POST /api/agents` directly? That endpoint expects a fully-formed
// agent payload from the agent-builder UI. This endpoint is the "I just
// had a great chat, save this configuration" entry point — it pulls
// shape from the thread instead of requiring the caller to fill it in.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getThread, getAgent, createAgent, updateThread } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Be concise and accurate. When you do not know something, say so. Use tools when relevant.";
const DEFAULT_TOOLS = ["web_search", "generate_artifact"];

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { threadId, name, description, icon, color, rebindThread } = body || {};
  if (!threadId || typeof threadId !== "string") {
    return NextResponse.json({ error: "threadId required" }, { status: 400 });
  }
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }

  const thread = await getThread(threadId, user.id);
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  // If the thread already has an agent, use its system prompt + tools as
  // the seed. Otherwise fall back to the platform defaults so the new
  // agent is at least usable out of the box.
  const sourceAgent = thread.agentId ? await getAgent(thread.agentId, user.id) : null;
  const systemPrompt = sourceAgent?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const tools = sourceAgent?.tools?.length ? sourceAgent.tools : DEFAULT_TOOLS;
  const connectorIds = sourceAgent?.connectorIds || [];

  const agent = await createAgent({
    userId: user.id,
    projectId: thread.projectId || null,
    name: name.trim().slice(0, 80),
    icon: (icon || (name.trim()[0] || "A").toUpperCase()).slice(0, 2),
    color: (["orange","blue","green","purple"].includes(color) ? color : "orange") as any,
    description: (description?.trim() || `Promoted from thread "${thread.title}"`).slice(0, 240),
    systemPrompt,
    tools,
    connectorIds,
    routerHint: sourceAgent?.routerHint || "",
  });

  // Optionally re-bind the originating thread to the new agent so future
  // turns in that thread use the saved config (rather than the floating
  // version that lived in the thread). Default true — the UI flow lands
  // here from a "Save as Agent" button and the user expects the thread to
  // continue using their newly-saved agent.
  if (rebindThread !== false) {
    await updateThread(threadId, user.id, { agentId: agent.id });
  }

  await audit({
    userId: user.id, action: "agent.create", resource: agent.id,
    result: "success",
    metadata: {
      source: "from-thread", threadId,
      sourceAgentId: thread.agentId || null,
      rebindThread: rebindThread !== false,
    },
    ...auditFromRequest(req),
  });

  return NextResponse.json({ agent });
}
