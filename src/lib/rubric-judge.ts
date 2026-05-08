// P26 — LLM-as-judge for rubric criteria.
//
// Judge calls a separate LLM (defaulted to a cheap fast model — Haiku or
// gpt-4o-mini) with a calibrated prompt that gives it:
//   - The user's original request
//   - The agent's final response
//   - A summary of tools the agent used
//   - The criterion to judge + scoring guide
//
// The judge returns structured JSON: { score, reasoning, evidence }.
// Score is on a 1-5 scale (1=worst, 5=best). The rubric layer maps scores to
// passes by threshold (default ≥3.5).
//
// CRITICAL: judgePromptVersion is bumped whenever this prompt template
// changes. Past evaluations remain comparable only within their judge version.

import { clientForUser, DEFAULT_MODEL } from "./llm";
import { withRetry } from "./providers";

export const JUDGE_PROMPT_VERSION = 1;
const JUDGE_MODEL = "claude-haiku-4-5-20250929"; // cheap + fast

export interface JudgeCriterion {
  name: string;
  description: string;
  scoringGuide?: Record<number, string>; // {5: "...", 4: "...", ...}
}

export interface JudgeInput {
  criterion: JudgeCriterion;
  userMessage: string;
  agentResponse: string;
  toolSummary: string;        // condensed list of tools used
  systemPromptHint?: string;  // optional snippet of agent's system prompt
  userId: string;
}

export interface JudgeOutput {
  score: number;            // 1-5
  reasoning: string;        // 1-2 sentences
  evidence?: string[];      // specific quotes from response that drove the score
  judgeModel: string;
  judgePromptVersion: number;
  durationMs: number;
}

const SYSTEM_PROMPT = `You are a rigorous quality judge for AI agent outputs. You score one specific criterion at a time. You're calibrated, consistent, and honest — you don't sandbag low scores when work is genuinely poor, and you don't inflate scores when work is genuinely good.

You return JSON only, no preamble:
{
  "score": <1|2|3|4|5>,
  "reasoning": "<one or two sentences justifying the score>",
  "evidence": ["<short quote or pattern from response that drove the score>", "..."]
}

Scale (default; the criterion may override):
  5 = Exceeds expectations. Production-grade.
  4 = Meets expectations. Solid work.
  3 = Acceptable but has gaps.
  2 = Below expectations. Significant issues.
  1 = Fails the criterion entirely.

Score the criterion in isolation. Don't let the agent's overall capability bleed into a single criterion's score.`;

function buildJudgeUserPrompt(input: JudgeInput): string {
  const guide = input.criterion.scoringGuide
    ? Object.entries(input.criterion.scoringGuide)
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .map(([s, desc]) => `  ${s} = ${desc}`).join("\n")
    : "(use default scale)";

  return `## CRITERION
Name: ${input.criterion.name}
Description: ${input.criterion.description}
Scoring guide:
${guide}

## USER REQUEST
${input.userMessage.slice(0, 2000)}

## AGENT RESPONSE
${input.agentResponse.slice(0, 6000)}

## TOOLS USED (condensed)
${input.toolSummary || "(none)"}

Score this criterion only. JSON only.`;
}

export async function judgeCriterion(input: JudgeInput): Promise<JudgeOutput> {
  const start = Date.now();
  const ant = await clientForUser(input.userId);

  const result = await withRetry(
    () => ant.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildJudgeUserPrompt(input) }],
    }),
    { maxAttempts: 2 },
  );

  let text = "";
  for (const b of result.content) if (b.type === "text") text += (b as any).text;

  // Extract JSON. The system prompt asks for JSON-only but models sometimes
  // wrap in code fences or add a stray sentence.
  let parsed: any;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : { score: 3, reasoning: "Judge returned no parseable JSON.", evidence: [] };
  } catch {
    parsed = { score: 3, reasoning: `Judge JSON parse failed: ${text.slice(0, 200)}`, evidence: [] };
  }

  const score = clampScore(parsed.score);
  return {
    score,
    reasoning: String(parsed.reasoning || "").slice(0, 600),
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 5).map((e: any) => String(e).slice(0, 200)) : [],
    judgeModel: JUDGE_MODEL,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    durationMs: Date.now() - start,
  };
}

function clampScore(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

// Convenience: build a tool-summary string from trace toolCalls
export function summarizeTools(toolCalls: Array<{ name: string; args?: any; success?: boolean }>): string {
  if (!toolCalls.length) return "(none)";
  const counts: Record<string, { ok: number; failed: number }> = {};
  for (const tc of toolCalls) {
    const c = counts[tc.name] || { ok: 0, failed: 0 };
    if (tc.success === false) c.failed++;
    else c.ok++;
    counts[tc.name] = c;
  }
  return Object.entries(counts)
    .map(([name, c]) => c.failed ? `${c.ok}× ${name} (${c.failed} failed)` : `${c.ok}× ${name}`)
    .join(", ");
}
