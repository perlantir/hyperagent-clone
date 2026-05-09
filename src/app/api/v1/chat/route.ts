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
import { retrieveMemoriesForChat } from "@/lib/memory";
import { composeSystemPrompt } from "@/lib/prompt-segments";
import { compilePrompt } from "@/lib/prompt-compiler";
import { computeCost, chargeCredits, balance } from "@/lib/credits";
import { startRun, endRun, TraceEmitter } from "@/lib/traces";
import { withRetry } from "@/lib/providers";
import { setBudgetCap, DEFAULT_V1_CALL_BUDGET } from "@/lib/budget";
import { enforceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { audit, auditFromRequest } from "@/lib/audit";

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
  if (!userId) {
    await audit({ userId: null, action: "api_key.used", result: "denied", ...auditFromRequest(req) });
    return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401 });
  }

  // P33a — per-user QPS rate limit on the public API. 60 req/min is generous
  // for any legitimate use; abuse looks like 1000+ req/min from one key.
  try {
    await enforceRateLimit({ userId, namespace: "v1_chat", maxRequests: 60, windowMs: 60_000 });
  } catch (e) {
    if (e instanceof RateLimitError) {
      await audit({ userId, action: "rate_limit.blocked", resource: "v1_chat", result: "denied", ...auditFromRequest(req) });
      return NextResponse.json(
        { error: "rate limit exceeded", retryAfterMs: e.retryAfterMs },
        { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } },
      );
    }
    throw e;
  }
  await audit({ userId, action: "api_key.used", result: "success", ...auditFromRequest(req) });

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
  // P25 — T1+T2 memory retrieval using the user's message as the cosine query
  const { pinned: pinnedMemories, contextual: contextualMemories } =
    await retrieveMemoriesForChat(userId, agentId, null, message);
  const toolNames = agent?.tools || ["web_search", "generate_artifact"];
  // P47 — honor agent's connectorIds + per-action connectorScopes.
  const { tools } = await resolveAllTools(userId, toolNames, {
    connectorIds: agent?.connectorIds,
    connectorScopes: agent?.connectorScopes,
  });

  // P23 — layered prompt with cache_control breakpoints.
  const segments = composeSystemPrompt({
    agent,
    toolNames: tools.map((t: any) => t.name),
    pinnedMemories,
    contextualMemories,
    threadContextDocId: threadId,
  });
  const compiled = compilePrompt(segments, { maxTokens: 16_000 });
  const systemBlocks = compiled.systemBlocks;

  // P28a — start trace for this v1 API call.
  const traceRunId = await startRun({
    userId, threadId, messageId: assistantMsg.id,
    agentId: agentId || null,
    kind: "v1_api",
  });
  const emitter = new TraceEmitter(traceRunId);
  emitter.setDefaultMetadata({
    promptFingerprint: compiled.fingerprint,
    agentId: agentId || null,
    requestId: req.headers.get("x-request-id") || req.headers.get("x-vercel-id") || null,
  });
  emitter.emit("prompt_compiled", {
    fingerprint: compiled.fingerprint,
    totalTokens: compiled.totalTokens,
    blockCount: compiled.systemBlocks.length,
    cacheBoundaries: compiled.systemBlocks.filter(b => (b as any).cache_control).length,
  });
  emitter.emit("memory_read", {
    count: pinnedMemories.length + contextualMemories.length,
    pinnedCount: pinnedMemories.length,
    contextualCount: contextualMemories.length,
  });

  // P27a — budget cap for v1 calls.
  await setBudgetCap(traceRunId, DEFAULT_V1_CALL_BUDGET);
  emitter.emit("budget_reserved", { runId: traceRunId, capCredits: DEFAULT_V1_CALL_BUDGET, scope: "v1_api" });

  let totalIn = 0, totalOut = 0, costCredits = 0;
  let content = "";
  let status: "succeeded" | "failed" = "succeeded";
  let errMsg: string | undefined;

  try {
    const ant = await clientForUser(userId);
    const llmStart = Date.now();
    // P29 — retry transient failures.
    const result = await withRetry(
      () => ant.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 2048,
        system: systemBlocks as any,
        messages: [{ role: "user", content: message }],
        tools: tools as any,
      }),
      {
        maxAttempts: 3,
        onRetry: (attempt, classified, delayMs) => {
          emitter.emit("retry", {
            attempt, errorClass: classified.class, reason: classified.reason,
            status: classified.status, delayMs,
          });
        },
      },
    );
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
