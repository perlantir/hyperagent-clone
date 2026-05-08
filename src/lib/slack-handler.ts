// Slack inbound: thread mapping + agent run + reply post.

import { pool, createThread, createMessage, getAgent, listAgents, updateMessage } from "./db";
import { clientForUser, DEFAULT_MODEL } from "./llm";
import { resolveAllTools, executeAnyTool, ToolCtx } from "./tools";
import { memoriesForContext, memoriesAsSystemBlock } from "./memory";
import { computeCost, chargeCredits, balance } from "./credits";

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
  const system = (agent?.systemPrompt || "You are a helpful AI assistant.") + memoriesAsSystemBlock(memories);
  const toolNames = agent?.tools || ["web_search", "generate_artifact"];
  const { tools } = await resolveAllTools(userId, toolNames);

  try {
    const ant = await clientForUser(userId);
    const result = await ant.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userText }],
      tools: tools as any,
    });
    let text = "";
    for (const b of result.content) if (b.type === "text") text += b.text;
    const cost = computeCost(result.usage?.input_tokens ?? 0, result.usage?.output_tokens ?? 0);
    await chargeCredits(userId, cost, "Slack reply", assistantMsg.id);
    await updateMessage(assistantMsg.id, { content: text });
    return text || "(empty response)";
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export async function postSlackReply(botToken: string, channel: string, threadTs: string, text: string) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${botToken}` },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
}
