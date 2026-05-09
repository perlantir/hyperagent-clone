// P50 — Regenerate the thread title from its message history.
//
// Asks the LLM to produce a 3-6 word title that captures the gist of
// the conversation. Used by the thread 3-dot menu's "Regenerate name"
// action when the auto-generated title from the first user message
// no longer reflects what the thread is actually about.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getThread, listMessages, updateThread } from "@/lib/db";
import { clientForUser, DEFAULT_MODEL } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const thread = await getThread(params.id, user.id);
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  const messages = await listMessages(params.id);
  if (messages.length === 0) {
    return NextResponse.json({ error: "thread has no messages yet" }, { status: 400 });
  }

  // Build a compact transcript — first 8 messages, content trimmed to
  // 400 chars each. Plenty of signal to title without bloating the prompt.
  const transcript = messages.slice(0, 8).map(m => {
    const role = m.role === "user" ? "User" : "Assistant";
    const content = (m.content || "").slice(0, 400).replace(/\s+/g, " ").trim();
    return `${role}: ${content}`;
  }).join("\n");

  let title: string;
  try {
    const anthropic = await clientForUser(user.id);
    const r = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 30,
      messages: [{
        role: "user",
        content: `Below is a conversation transcript. Produce a concise title (3-6 words, no quotes, no punctuation at the end, sentence-case) that describes what the conversation is about. Title only — no preamble.\n\n---\n${transcript}\n---\n\nTitle:`,
      }],
    });
    const block = r.content?.[0];
    title = (block && block.type === "text" ? block.text : "").trim();
    // Strip surrounding quotes / trailing punctuation if the model added any.
    title = title.replace(/^["'`]+|["'`.]+$/g, "").trim();
    if (!title) throw new Error("empty title");
    if (title.length > 80) title = title.slice(0, 80);
  } catch (e: any) {
    return NextResponse.json({ error: `Could not regenerate title: ${e.message || e}` }, { status: 500 });
  }

  await updateThread(params.id, user.id, { title });
  return NextResponse.json({ ok: true, title });
}
