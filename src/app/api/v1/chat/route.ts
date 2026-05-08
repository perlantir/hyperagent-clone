// Public API (P17). Bearer-token authenticated chat endpoint.
//   POST /api/v1/chat
//   Authorization: Bearer hak_...
//   Body: { agentId?: string, message: string, threadId?: string }
// Returns: { threadId, messageId, content, costCredits }

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { pool, createMessage, createThread, getAgent, updateMessage } from "@/lib/db";
import { clientForUser, DEFAULT_MODEL } from "@/lib/llm";
import { resolveAllTools } from "@/lib/tools";
import { memoriesForContext, memoriesAsSystemBlock } from "@/lib/memory";
import { computeCost, chargeCredits, balance } from "@/lib/credits";
import { startRun, endRun, TraceEmitter } from "@/lib/traces";

export const runtime = "nodejs";
export const maxDuration = 120;

async function ensureKeyTable() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      "keyHash" TEXT NOT NULL UNIQUE,
      "keyPrefix" TEXT NOT NULL,
      "lastUsedAt" BIGINT,
      "createdAt" BIGINT NOT NULL
    );
  `);
}

function hashKey(raw: string) { return crypto.createHash("sha256").update(raw).digest("hex"); }

async function authenticate(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(hak_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  // Treat DB unavailability as auth failure rather than 500ing — keeps /api/v1/chat
  // safe to probe in environments where DATABASE_URL hasn't been wired yet.
  try {
    await ensureKeyTable();
    const r = await pool().query(`SELECT "userId", id FROM api_keys WHERE "keyHash"=$1`, [hashKey(m[1])]);
    if (!r.rows[0]) return null;
    await pool().query(`UPDATE api_keys SET "lastUsedAt"=$1 WHERE id=$2`, [Date.now(), r.rows[0].id]);
    return r.rows[0].userId;
  } catch (e) {
    console.error("[v1/chat authenticate]", e);
    return null;
  }
}

export async function POST(req: Request) {
  const userId = await authenticate(req);
  if (!userId) return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401 });

  const { agentId, message, threadId: existingThreadId } = await req.json().catch(() => ({}));
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });

  if ((await balance(userId)) <= 0) return NextResponse.json({ error: "out of credits" }, { status: 402 });

  let threadId = existingThreadId;
  if (!threadId) {
    const t = await createThread(userId, message.slice(0, 60), agentId || null);
    threadId = t.id;
  }

  await createMessage({ threadId, role: "user", content: message });
  const assistantMsg = await createMessage({ threadId, role: "assistant", content: "" });

  const agent = agentId ? await getAgent(agentId, userId) : null;
  const memories = await memoriesForContext(userId, agentId, null);
  const system = (agent?.systemPrompt || "You are a helpful AI assistant.") + memoriesAsSystemBlock(memories);
  const toolNames = agent?.tools || ["web_search", "generate_artifact"];
  const { tools } = await resolveAllTools(userId, toolNames);

  // P28a — start trace for this v1 API call.
  const traceRunId = await startRun({
    userId, threadId, messageId: assistantMsg.id,
    agentId: agentId || null,
    kind: "v1_api",
  });
  const emitter = new TraceEmitter(traceRunId);

  let totalIn = 0, totalOut = 0, costCredits = 0;
  let content = "";
  let status: "succeeded" | "failed" = "succeeded";
  let errMsg: string | undefined;

  try {
    const ant = await clientForUser(userId);
    const llmStart = Date.now();
    const result = await ant.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: message }],
      tools: tools as any,
    });
    const llmDuration = Date.now() - llmStart;
    totalIn = result.usage?.input_tokens ?? 0;
    totalOut = result.usage?.output_tokens ?? 0;
    emitter.emit("llm_call", {
      model: DEFAULT_MODEL,
      inputTokens: totalIn, outputTokens: totalOut,
      stopReason: result.stop_reason,
    }, { durationMs: llmDuration });
    for (const b of result.content) if (b.type === "text") content += b.text;
    costCredits = computeCost(totalIn, totalOut);
    await chargeCredits(userId, costCredits, "Public API", assistantMsg.id);
    await updateMessage(assistantMsg.id, { content });
  } catch (e: any) {
    status = "failed";
    errMsg = e?.message || String(e);
    emitter.emit("error", { source: "v1_chat", message: errMsg });
    await updateMessage(assistantMsg.id, { content: `Error: ${errMsg}` });
  }

  try {
    await emitter.flush();
    await endRun(traceRunId, {
      status,
      totalInputTokens: totalIn, totalOutputTokens: totalOut,
      totalCostCredits: costCredits, errorMessage: errMsg,
    });
  } catch (traceErr) {
    console.error("[trace finalize v1]", traceErr);
  }

  if (status === "failed") {
    return NextResponse.json({ error: errMsg, runId: traceRunId }, { status: 500 });
  }
  return NextResponse.json({ threadId, messageId: assistantMsg.id, content, costCredits, runId: traceRunId });
}
