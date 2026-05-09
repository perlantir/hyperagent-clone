// P38 — Build skill from a thread.
//
//   POST /api/threads/{threadId}/build-skill
//   Body: { name?: string, description?: string }   (optional overrides)
//   → { skill: {...} }
//
// Distills a thread's successful approach into a reusable skill: name +
// description + system_prompt_addition. The user can override the
// LLM-suggested name/description; persistence happens server-side.
// Skills written here use installedFromTemplate=`thread:<id>` so the
// lineage is visible.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { getThread, listMessages, pool } from "@/lib/db";
import { clientForUser } from "@/lib/llm";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYSTEM_PROMPT = `You read a conversation between a user and their AI agent. Distill the agent's *approach* — the structural moves, the format choices, the implicit rules it followed — into a reusable skill prompt that another agent could apply to similar future tasks.

Respond with strict JSON of shape:
{"name": "<short skill name, max 60 chars>",
 "description": "<one sentence describing when to use this>",
 "category": "Research|Writing|Productivity|Developer|Compliance|Custom",
 "systemPromptAddition": "<plain instructions the agent should follow when this skill applies>"}

The systemPromptAddition should be 1-4 short paragraphs, written as direct instructions. Don't quote the source conversation. Don't include a preamble — the prompt should be ready to drop into another agent's context as-is.`;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const thread = await getThread(params.id, user.id);
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const messages = await listMessages(params.id);
  if (messages.length < 2) {
    return NextResponse.json({ error: "thread too short to distill" }, { status: 400 });
  }

  const recent = messages.slice(-16).map(m => ({
    role: m.role,
    content: (m.content || "").slice(0, 1500),
  }));

  const ant = await clientForUser(user.id);
  const result = await ant.messages.create({
    model: "claude-haiku-4-5-20250929",
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Conversation:\n\n${JSON.stringify(recent, null, 2)}` }],
  });

  let text = "";
  for (const b of result.content) if (b.type === "text") text += b.text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let extracted: any = {};
  if (jsonMatch) { try { extracted = JSON.parse(jsonMatch[0]); } catch {} }

  const name = (body.name || extracted.name || `From "${thread.title}"`).slice(0, 80);
  const description = (body.description || extracted.description || "").slice(0, 240);
  const category = (extracted.category || "Custom").slice(0, 40);
  const systemPromptAddition = (extracted.systemPromptAddition || "").slice(0, 6000);

  if (!systemPromptAddition.trim()) {
    return NextResponse.json({ error: "could not distill a skill from this thread" }, { status: 422 });
  }

  const id = "sk_" + crypto.randomBytes(8).toString("hex");
  await pool().query(
    `INSERT INTO skills (id, "userId", name, description, category, "systemPromptAddition", "toolHints", "isTemplate", "installedFromTemplate", "createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,'[]',0,$7,$8)`,
    [id, user.id, name, description, category, systemPromptAddition, `thread:${params.id}`, Date.now()],
  );

  await audit({
    userId: user.id,
    action: "skill.create_from_thread",
    resource: id,
    result: "success",
    metadata: { threadId: params.id, name, category },
    ...auditFromRequest(req),
  });

  return NextResponse.json({
    skill: { id, name, description, category, systemPromptAddition },
  });
}
