// Multi-agent smart routing. Given a user message + the user's available agents,
// pick the best one. Uses a small LLM call (the same Anthropic client).

import { clientForUser, DEFAULT_MODEL } from "./llm";
import type { Agent } from "./types";
import { withRetry } from "./providers";

export interface RouterDecision {
  agentId: string;
  reason: string;
}

export async function routeMessage(message: string, agents: Agent[], userId?: string): Promise<RouterDecision> {
  // Filter out the router agent itself if present.
  const candidates = agents.filter(a => a.name.toLowerCase() !== "router");
  if (!candidates.length) throw new Error("No candidate agents");
  if (candidates.length === 1) return { agentId: candidates[0].id, reason: "Only one candidate available." };

  const system = `You are a router. Read the user message and pick the best specialist agent for it.
Return ONLY JSON in this shape: {"agentId": "...", "reason": "..."}.
The reason must be ≤ 12 words.`;

  const list = candidates.map(a =>
    `- id: ${a.id}\n  name: ${a.name}\n  hint: ${a.routerHint || a.description}`
  ).join("\n");

  const userPrompt = `User message:\n${message}\n\nAgents:\n${list}\n\nRespond with JSON only.`;

  const ant = await clientForUser(userId);
  // P29 — retry transient failures. Router is a small focused single-shot
  // call (≤200 output tokens), so a full layered prompt offers no caching
  // benefit; the targeted system prompt above is correct for this surface.
  const result = await withRetry(
    () => ant.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }),
    { maxAttempts: 3 },
  );

  let text = "";
  for (const b of result.content) if (b.type === "text") text += b.text;

  // Extract JSON from the response.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return { agentId: candidates[0].id, reason: "Router returned no JSON; defaulted to first agent." };
  }
  try {
    const parsed = JSON.parse(match[0]);
    const found = candidates.find(a => a.id === parsed.agentId);
    if (found) return { agentId: found.id, reason: String(parsed.reason || "") };
    // If LLM hallucinated an id, fall back to the first candidate.
    return { agentId: candidates[0].id, reason: `Hallucinated id '${parsed.agentId}', fell back.` };
  } catch {
    return { agentId: candidates[0].id, reason: "Router JSON unparseable; fell back." };
  }
}
