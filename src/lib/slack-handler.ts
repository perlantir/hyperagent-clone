// Slack inbound: thread mapping + agent run + reply post.

import { pool, createThread, createMessage, getAgent, listAgents, updateMessage } from "./db";
import { clientForUser, DEFAULT_MODEL } from "./llm";
import { resolveAllTools, executeAnyTool, ToolCtx } from "./tools";
import { memoriesForContext } from "./memory";
import { computeCost, chargeCredits, balance } from "./credits";
import { composeSystemPrompt } from "./prompt-segments";
import { compilePrompt } from "./prompt-compiler";
import { withRetry } from "./providers";
import { startRun, endRun, TraceEmitter } from "./traces";
import { setBudgetCap, DEFAULT_SLACK_INBOUND_BUDGET } from "./budget";

export async function findOrCreateSlackThread(
  userId: string,
  agentId: string | null,
  channel: string,
  threadTs: string,
  firstText: string,
): Promise<string> {
  const r = await pool().query(`SELECT "threadId" FROM slack_threads WHERE slack_channel=$1 AND slack_ts=$2`, [channel, threadTs]);
  if (r.rows[0]) return r.rows[0].threadId;
  const thread = await createThread(userId, `[Slack] ${firstText.slice(0, 60)}`, agentId);
  await pool().query(`INSERT INTO slack_threads (slack_channel, slack_ts, "threadId") VALUES ($1,$2,$3)`, [channel, threadTs, thread.id]);
  return thread.id;
}

export async function runAgentForSlack(userId: string, agentId: string | null, threadId: string, userText: string): Promise<string> {
  if ((await balance(userId)) <= 0) return "⚠️ Out of credits. Top up at https://hyperagent-app.vercel.app/billing";

  await createMessage({ threadId, role: "user", content: userText });
  const assistantMsg = await createMessage({ threadId, role: "assistant", content: "" });

  const agent = agentId ? await getAgent(agentId, userId) : null;
  const memories = await memoriesForContext(userId, agentId, null);
  const toolNames = agent?.tools || ["web_search", "generate_artifact"];
  const { tools } = await resolveAllTools(userId, toolNames);

  // P23 — layered prompt with cache breakpoints.
  const segments = composeSystemPrompt({
    agent,
    toolNames: tools.map((t: any) => t.name),
    pinnedMemories: memories.filter((m: any) => (m.importance || 0) >= 8),
    contextualMemories: memories.filter((m: any) => (m.importance || 0) < 8),
    threadContextDocId: null,
  });
  const compiled = compilePrompt(segments, { maxTokens: 16_000 });

  // P28a — start trace + P27a budget cap.
  const traceRunId = await startRun({
    userId, threadId, messageId: assistantMsg.id,
    agentId: agent?.id || null,
    kind: "slack_inbound",
  });
  const emitter = new TraceEmitter(traceRunId);
  emitter.setDefaultMetadata({ promptFingerprint: compiled.fingerprint, agentId: agent?.id || null });
  emitter.emit("prompt_compiled", {
    fingerprint: compiled.fingerprint, totalTokens: compiled.totalTokens,
    blockCount: compiled.systemBlocks.length,
  });
  await setBudgetCap(traceRunId, DEFAULT_SLACK_INBOUND_BUDGET);
  emitter.emit("budget_reserved", { runId: traceRunId, capCredits: DEFAULT_SLACK_INBOUND_BUDGET, scope: "slack_inbound" });

  let totalIn = 0, totalOut = 0, cost = 0;
  let status: "succeeded" | "failed" = "succeeded";
  let errMsg: string | undefined;
  let text = "";

  try {
    const ant = await clientForUser(userId);
    const llmStart = Date.now();
    // P29 — retry transient failures
    const result = await withRetry(
      () => ant.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: compiled.systemBlocks as any,
        messages: [{ role: "user", content: userText }],
        tools: tools as any,
      }),
      {
        maxAttempts: 3,
        onRetry: (attempt, classified, delayMs) =>
          emitter.emit("retry", { attempt, errorClass: classified.class, reason: classified.reason, delayMs }),
      },
    );
    const llmDuration = Date.now() - llmStart;
    totalIn = result.usage?.input_tokens ?? 0;
    totalOut = result.usage?.output_tokens ?? 0;
    emitter.emit("llm_call", {
      model: DEFAULT_MODEL, inputTokens: totalIn, outputTokens: totalOut,
      stopReason: result.stop_reason,
    }, { durationMs: llmDuration });

    for (const b of result.content) if (b.type === "text") text += b.text;
    cost = computeCost(totalIn, totalOut);
    await chargeCredits(userId, cost, "Slack reply", assistantMsg.id);
    await updateMessage(assistantMsg.id, { content: text });
  } catch (e: any) {
    status = "failed";
    errMsg = e?.message || String(e);
    emitter.emit("error", { source: "slack_handler", message: errMsg });
    text = `Error: ${errMsg}`;
  }

  try {
    await emitter.flush();
    await endRun(traceRunId, {
      status, totalInputTokens: totalIn, totalOutputTokens: totalOut,
      totalCostCredits: cost, errorMessage: errMsg,
    });
  } catch (traceErr) { console.error("[trace finalize slack]", traceErr); }

  return text || "(empty response)";
}

export async function postSlackReply(botToken: string, channel: string, threadTs: string, text: string) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${botToken}` },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
}
