// P35 — Per-agent webhook invocation.
//
//   POST /api/v1/agents/{agentId}/invoke
//   Authorization: Bearer hak_...
//   Body: { message: string, threadId?: string }
//   Response: { threadId, messageId, content, costCredits, runId }
//
// Same auth + rate-limit + budget machinery as /api/v1/chat, but with
// the agentId pre-bound from the URL path. The bearer token must own the
// agent — we 404 when the agent doesn't exist for that user (not 403, so
// agent IDs aren't an enumeration oracle).
//
// Why a separate route rather than just calling /api/v1/chat with an
// agentId parameter? Two reasons: it gives users a copy-pasteable
// canonical URL per agent for webhook integrations, and it audit-logs
// the agent dispatch as a distinct action so the audit log can answer
// "which webhook fired this?" without cross-referencing payload bodies.
//
// To use, the caller still needs an API key — we don't yet support
// per-agent webhook secrets (no signed-request flow). That's flagged as
// future work in the README.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  pool, createMessage, createThread, getAgent, getThread, updateMessage,
} from "@/lib/db";
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

function hashKey(raw: string) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Two auth modes:
//   1. Bearer hak_... (API key) — global, scoped to user.
//   2. X-Hyperagent-Signature: t=<unix>,v1=<hmac> — per-agent webhook
//      secret. HMAC-SHA256 over `<unix>.<raw_body>`. 5-min skew tolerance.
//      Lets users wire raw webhooks (Stripe-style) without minting API keys.
async function authenticate(req: Request, agentId: string, rawBody: string): Promise<string | null> {
  // 1. Bearer-token path (existing).
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(hak_[A-Za-z0-9_-]+)$/);
  if (m) {
    try {
      const r = await pool().query(
        `SELECT "userId", id FROM api_keys WHERE "keyHash"=$1`,
        [hashKey(m[1])],
      );
      if (r.rows[0]) {
        await pool().query(
          `UPDATE api_keys SET "lastUsedAt"=$1 WHERE id=$2`,
          [Date.now(), r.rows[0].id],
        );
        return r.rows[0].userId;
      }
    } catch (e) { console.error("[v1/agents/invoke authenticate bearer]", e); }
  }

  // 2. P41 — HMAC signature path. Per-agent webhook secret.
  const sigHeader = req.headers.get("x-hyperagent-signature");
  if (sigHeader) {
    try {
      const parts = Object.fromEntries(sigHeader.split(",").map(p => p.split("=")));
      const ts = parts.t;
      const v1 = parts.v1;
      if (!ts || !v1) return null;
      // 5-minute skew tolerance.
      if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return null;

      const r = await pool().query(
        `SELECT "userId", "webhookSecret" FROM agents WHERE id=$1`,
        [agentId],
      );
      const row = r.rows[0];
      if (!row || !row.webhookSecret) return null;

      const expected = crypto.createHmac("sha256", row.webhookSecret)
        .update(`${ts}.${rawBody}`).digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(v1);
      if (a.length !== b.length) return null;
      if (!crypto.timingSafeEqual(a, b)) return null;
      return row.userId;
    } catch (e) { console.error("[v1/agents/invoke authenticate hmac]", e); }
  }

  return null;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  // P41 — read the raw body once so we can both HMAC-verify and JSON-parse
  // it. Cloning would also work but raw text + manual parse is simplest.
  const rawBody = await req.text();

  const userId = await authenticate(req, params.id, rawBody);
  if (!userId) {
    await audit({ userId: null, action: "api_key.used", result: "denied", ...auditFromRequest(req) });
    return NextResponse.json({ error: "Invalid or missing credentials (Bearer token or X-Hyperagent-Signature)" }, { status: 401 });
  }

  // Rate limit shares the namespace with /api/v1/chat so a noisy caller
  // can't bypass by alternating between the two endpoints.
  try {
    await enforceRateLimit({ userId, namespace: "v1_chat", maxRequests: 60, windowMs: 60_000 });
  } catch (e) {
    if (e instanceof RateLimitError) {
      await audit({ userId, action: "rate_limit.blocked", resource: "v1_agents_invoke", result: "denied", ...auditFromRequest(req) });
      return NextResponse.json(
        { error: "rate limit exceeded", retryAfterMs: e.retryAfterMs },
        { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } },
      );
    }
    throw e;
  }

  // Authz: the agent must exist AND belong to this user. Return 404 (not 403)
  // when the agent is missing or owned by someone else, so an attacker
  // brute-forcing IDs can't enumerate which exist.
  const agent = await getAgent(params.id, userId);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  await audit({
    userId, action: "api_key.used", resource: `agents/${agent.id}/invoke`,
    result: "success", metadata: { agentId: agent.id, agentName: agent.name },
    ...auditFromRequest(req),
  });

  // We've already consumed the body above for HMAC; parse the captured raw text.
  let parsed: any = {};
  try { parsed = rawBody ? JSON.parse(rawBody) : {}; } catch {}
  const { message, threadId: existingThreadId } = parsed;
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });

  if ((await balance(userId)) <= 0) return NextResponse.json({ error: "out of credits" }, { status: 402 });

  // If a threadId is provided, verify it belongs to this user too.
  let threadId = existingThreadId;
  if (threadId) {
    const t = await getThread(threadId, userId);
    if (!t) return NextResponse.json({ error: "thread not found" }, { status: 404 });
  } else {
    const t = await createThread(userId, message.slice(0, 60), agent.id);
    threadId = t.id;
  }

  await createMessage({ threadId, role: "user", content: message });
  const assistantMsg = await createMessage({ threadId, role: "assistant", content: "" });

  // Same prompt + memory + tool plumbing as /api/v1/chat — just with the
  // agent already resolved.
  const { pinned: pinnedMemories, contextual: contextualMemories } =
    await retrieveMemoriesForChat(userId, agent.id, null, message);
  const toolNames = agent.tools?.length ? agent.tools : ["web_search", "generate_artifact"];
  const { tools } = await resolveAllTools(userId, toolNames);

  const segments = composeSystemPrompt({
    agent,
    toolNames: tools.map((t: any) => t.name),
    pinnedMemories,
    contextualMemories,
    threadContextDocId: threadId,
  });
  const compiled = compilePrompt(segments, { maxTokens: 16_000 });
  const systemBlocks = compiled.systemBlocks;

  const traceRunId = await startRun({
    userId, threadId, messageId: assistantMsg.id,
    agentId: agent.id, kind: "v1_api",
    metadata: { invoker: "agents/invoke", agentName: agent.name },
  });
  const emitter = new TraceEmitter(traceRunId);
  emitter.setDefaultMetadata({
    promptFingerprint: compiled.fingerprint,
    agentId: agent.id,
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
  await setBudgetCap(traceRunId, DEFAULT_V1_CALL_BUDGET);
  emitter.emit("budget_reserved", { runId: traceRunId, capCredits: DEFAULT_V1_CALL_BUDGET, scope: "v1_api" });

  let totalIn = 0, totalOut = 0, costCredits = 0;
  let content = "";
  let status: "succeeded" | "failed" = "succeeded";
  let errMsg: string | undefined;

  try {
    const ant = await clientForUser(userId);
    const llmStart = Date.now();
    // P36 — per-agent model override.
    const effectiveModel = (agent as any).modelId || DEFAULT_MODEL;
    const result = await withRetry(
      () => ant.messages.create({
        model: effectiveModel,
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
      model: effectiveModel,
      inputTokens: totalIn, outputTokens: totalOut,
      stopReason: result.stop_reason,
    }, { durationMs: llmDuration });
    for (const b of result.content) if (b.type === "text") content += b.text;
    costCredits = computeCost(totalIn, totalOut);
    await chargeCredits(userId, costCredits, `Webhook → ${agent.name}`, assistantMsg.id);
    await updateMessage(assistantMsg.id, { content });
  } catch (e: any) {
    status = "failed";
    errMsg = e?.message || String(e);
    emitter.emit("error", { source: "v1_agents_invoke", message: errMsg });
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
    console.error("[trace finalize v1/agents/invoke]", traceErr);
  }

  if (status === "failed") {
    return NextResponse.json({ error: errMsg, runId: traceRunId }, { status: 500 });
  }
  return NextResponse.json({
    threadId, messageId: assistantMsg.id, content, costCredits, runId: traceRunId,
    agentId: agent.id, agentName: agent.name,
  });
}
