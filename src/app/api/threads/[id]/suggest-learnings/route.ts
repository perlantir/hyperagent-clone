// P38 — Suggest learnings for a thread.
//
//   POST /api/threads/{threadId}/suggest-learnings
//   → { proposals: [{ kind: "memory"|"skill", content, importance?, category? }] }
//
// Reads the most recent N messages, asks Haiku to extract 1-3 candidate
// memories or skill prompts that would help the agent on future similar
// turns. Each accepted proposal is persisted with state="proposed" so the
// user reviews + accepts via /learning before they go live.
//
// This is the manual trigger for the existing improvement-proposal
// pipeline that runs automatically after multi-step turns (P26 / P25b).

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { getThread, listMessages, pool } from "@/lib/db";
import { clientForUser } from "@/lib/llm";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYSTEM_PROMPT = `You read a conversation between a user and their AI agent and propose 1-3 candidate "learnings" — either:
- Memories: durable facts, preferences, or constraints worth remembering for future turns ("user prefers takeaway-first format", "always cite sources as footnotes").
- Skills: reusable system-prompt additions that capture a successful approach ("when teardown-style requests come in, structure as Positioning / Product / Pricing / GTM").

Respond with strict JSON of shape:
{"proposals": [
  {"kind": "memory", "content": "<one sentence>", "category": "preference|user_fact|tools_and_workflows|domain_knowledge", "importance": 1-10},
  {"kind": "skill", "name": "<short name>", "description": "<one sentence>", "systemPromptAddition": "<system prompt text>"}
]}

Only propose learnings that are non-obvious and would generalize. Skip generic observations like "user wants accurate answers". Maximum 3 proposals total.`;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const thread = await getThread(params.id, user.id);
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  const messages = await listMessages(params.id);
  if (messages.length < 2) {
    return NextResponse.json({ proposals: [], reason: "not enough conversation to analyze" });
  }

  // Take the last ~12 messages to keep the call cheap. We summarize with
  // role + truncated content; tool calls + artifacts get a one-line note.
  const recent = messages.slice(-12).map(m => ({
    role: m.role,
    content: (m.content || "").slice(0, 1200),
    tools: m.toolCalls?.map(t => t.name).join(", ") || undefined,
  }));

  const ant = await clientForUser(user.id);
  const result = await ant.messages.create({
    model: "claude-haiku-4-5-20250929",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Conversation:\n\n${JSON.stringify(recent, null, 2)}` }],
  });

  let text = "";
  for (const b of result.content) if (b.type === "text") text += b.text;

  // Strip code fences if the model wraps JSON in ```json ... ```
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let proposals: any[] = [];
  if (jsonMatch) {
    try { proposals = JSON.parse(jsonMatch[0]).proposals || []; } catch {}
  }

  // Persist each proposal at state=proposed so /learning surfaces it.
  for (const p of proposals.slice(0, 3)) {
    if (p.kind === "memory" && typeof p.content === "string") {
      const id = "mem_" + crypto.randomBytes(8).toString("hex");
      await pool().query(
        `INSERT INTO memories (id, "userId", "agentId", "projectId", content, importance, "createdAt", state, category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed',$8)`,
        [
          id, user.id, thread.agentId || null, thread.projectId || null,
          String(p.content).slice(0, 800),
          Math.max(1, Math.min(10, Number(p.importance) || 6)),
          Date.now(), p.category || null,
        ],
      );
    } else if (p.kind === "skill" && typeof p.name === "string" && typeof p.systemPromptAddition === "string") {
      // Skill proposals get persisted into skills table with isTemplate=0 +
      // installedFromTemplate="thread:<id>" so we can identify the lineage.
      const id = "sk_" + crypto.randomBytes(8).toString("hex");
      await pool().query(
        `INSERT INTO skills (id, "userId", name, description, category, "systemPromptAddition", "toolHints", "isTemplate", "installedFromTemplate", "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,'[]',0,$7,$8)`,
        [
          id, user.id,
          String(p.name).slice(0, 80),
          String(p.description || "").slice(0, 240) || `Promoted from thread "${thread.title}"`,
          "Custom",
          String(p.systemPromptAddition).slice(0, 4000),
          `thread:${params.id}`, Date.now(),
        ],
      );
    }
  }

  await audit({
    userId: user.id,
    action: "memory.write",
    resource: params.id,
    result: "success",
    metadata: { source: "suggest-learnings", proposalCount: proposals.length },
    ...auditFromRequest(req),
  });

  return NextResponse.json({ proposals });
}
