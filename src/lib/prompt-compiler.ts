// P23 — Prompt compiler.
//
// Takes an array of PromptSegments, applies token budgeting + tier-based
// Anthropic cache_control breakpoints + provenance fingerprinting, and emits
// the structured system blocks that get sent to the model.
//
// Key invariants:
//   - REQUIRED segment kinds (safety, tool_policy, approval_policy, rubric)
//     are NEVER silently dropped. If they exceed budget, the compiler emits an
//     "overbudget" trace event and includes them anyway. Caller is responsible
//     for catching this.
//   - Cache breakpoints are placed at tier boundaries so subsequent calls within
//     the 5-min TTL hit cached prefixes.
//   - Every compile emits a fingerprint = sha256 of (segment kind + content hash
//     + version) joined. Two compiles with identical inputs produce identical
//     fingerprints, useful for cache validation and trace correlation.
//
// Designed for P28a (Trace Skeleton) integration via the optional `emitter`
// callback — when traces ship, every compile emits "prompt_compiled" with
// fingerprint, included/dropped kinds, total tokens, and cache boundary info.

import crypto from "node:crypto";

export type SegmentKind =
  // === TIER 1: stable across all calls (cached 5 min) ===
  | "platform_identity"   // who Hyperagent is
  | "safety"              // refusal policy [REQUIRED — never drops]
  | "architecture"        // platform capability awareness
  | "tool_policy"         // tool selection guidance [REQUIRED]
  | "output_format"       // response formatting rules
  | "meta_awareness"      // self-reflection prompts
  | "approval_policy"     // human-in-loop gates [REQUIRED if approvals exist]
  // === TIER 2: stable per agent (cached 5 min) ===
  | "org_context"         // org/project info
  | "agent_config"        // user's agent system prompt
  | "working_memory_hint" // thread context doc ID + update guidance
  // === TIER 3: stable per run (cached 5 min) ===
  | "rubric"              // quality criteria for this run [REQUIRED if attached]
  // === TIER 4: volatile, never cached ===
  | "memory_pinned"       // T1 always-present memories
  | "memory_contextual"   // T2 retrieved-this-turn memories
  | "files_artifacts"     // attached files / artifact references
  | "budget"              // remaining budget hint
  | "current_task"        // explicit task framing
  | "response_contract"   // shape requirements (JSON only, etc.)
  | "recency_boost";      // critical context placed last for salience

export interface PromptSegment {
  kind: SegmentKind;
  content: string;          // the actual text
  priority: number;         // 0-100, higher = keep when budget tight
  required?: boolean;       // override — never drop
  source: string;           // provenance, e.g. "platform/v1" or "agent/abc/v3"
  version?: number;         // bump when content semantics change
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface CompiledPrompt {
  systemBlocks: AnthropicTextBlock[];
  fingerprint: string;
  totalTokens: number;
  includedSegments: Array<{ kind: SegmentKind; tokens: number; tier: 1 | 2 | 3 | 4 }>;
  droppedSegments: Array<{ kind: SegmentKind; reason: string }>;
}

export interface CompileOptions {
  maxTokens: number;
  emitter?: (event: any) => void;
}

// =================== TIER MAPPING ===================
// Tiers determine cache breakpoints. Anthropic supports up to 4 cache_control
// markers per request — we use 3 (one per stable tier).

const TIER: Record<SegmentKind, 1 | 2 | 3 | 4> = {
  platform_identity: 1, safety: 1, architecture: 1, tool_policy: 1,
  output_format: 1, meta_awareness: 1, approval_policy: 1,
  org_context: 2, agent_config: 2, working_memory_hint: 2,
  rubric: 3,
  memory_pinned: 4, memory_contextual: 4, files_artifacts: 4,
  budget: 4, current_task: 4, response_contract: 4, recency_boost: 4,
};

// Canonical ordering within each tier for deterministic output.
const KIND_ORDER: Record<SegmentKind, number> = {
  platform_identity: 0, safety: 1, architecture: 2, tool_policy: 3,
  output_format: 4, meta_awareness: 5, approval_policy: 6,
  org_context: 10, agent_config: 11, working_memory_hint: 12,
  rubric: 20,
  memory_pinned: 30, memory_contextual: 31,
  files_artifacts: 40, budget: 41,
  current_task: 50, response_contract: 51,
  recency_boost: 60,
};

// Required kinds — these never drop silently. Compiler emits a warning event
// if they would push the request over budget.
const REQUIRED_KINDS: ReadonlySet<SegmentKind> = new Set([
  "safety", "tool_policy", "approval_policy", "rubric",
]);

// =================== ESTIMATION ===================

// Anthropic doesn't expose a public token counter for arbitrary strings, so we
// approximate at ~4 characters per token (English with whitespace). Empirically
// within 10% for prose; less accurate for code/JSON but safe-side.
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
}

// =================== COMPILE ===================

export function compilePrompt(segments: PromptSegment[], opts: CompileOptions): CompiledPrompt {
  // 1. Sort by canonical order so output is deterministic
  const sorted = [...segments].sort((a, b) => {
    const ord = (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99);
    if (ord !== 0) return ord;
    return (b.priority ?? 50) - (a.priority ?? 50); // higher priority first within same kind
  });

  // 2. Token budgeting — drop lowest-priority NON-REQUIRED segments first
  let used = 0;
  const included: PromptSegment[] = [];
  const dropped: Array<{ kind: SegmentKind; reason: string }> = [];

  // Two-pass: include all required first regardless of budget, then fill with
  // non-required by priority desc until budget exhausted.
  const required = sorted.filter(s => s.required || REQUIRED_KINDS.has(s.kind));
  const optional = sorted
    .filter(s => !(s.required || REQUIRED_KINDS.has(s.kind)))
    .sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));

  for (const s of required) {
    const t = estimateTokens(s.content);
    if (used + t > opts.maxTokens) {
      opts.emitter?.({
        type: "prompt_overbudget",
        kind: s.kind, source: s.source,
        wouldCost: t, alreadyUsed: used, cap: opts.maxTokens,
      });
    }
    included.push(s);
    used += t;
  }

  for (const s of optional) {
    const t = estimateTokens(s.content);
    if (used + t > opts.maxTokens) {
      dropped.push({ kind: s.kind, reason: `over budget at +${t} tokens (${used}/${opts.maxTokens})` });
      continue;
    }
    included.push(s);
    used += t;
  }

  // Re-sort included segments by canonical order (we needed priority order
  // for budgeting; now we want canonical order for output).
  included.sort((a, b) => (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99));

  // 3. Group by tier and assemble system blocks
  const tierGroups: Record<1 | 2 | 3 | 4, PromptSegment[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const s of included) tierGroups[TIER[s.kind]].push(s);

  const systemBlocks: AnthropicTextBlock[] = [];
  for (const tier of [1, 2, 3, 4] as const) {
    const segs = tierGroups[tier];
    if (segs.length === 0) continue;
    const text = segs.map(s => s.content).join("\n\n");
    const block: AnthropicTextBlock = { type: "text", text };
    // Tier 1, 2, 3 are cacheable. Tier 4 is volatile.
    if (tier <= 3) block.cache_control = { type: "ephemeral" };
    systemBlocks.push(block);
  }

  // 4. Compute fingerprint
  const fingerprintInput = included
    .map(s => `${s.kind}:${hashContent(s.content)}:v${s.version || 1}`)
    .join("|");
  const fingerprint = crypto.createHash("sha256")
    .update(fingerprintInput).digest("hex").slice(0, 16);

  // 5. Emit trace event (no-op if no emitter)
  opts.emitter?.({
    type: "prompt_compiled",
    fingerprint,
    totalTokens: used,
    cap: opts.maxTokens,
    blockCount: systemBlocks.length,
    cacheBoundaries: systemBlocks.filter(b => b.cache_control).length,
    included: included.map(s => ({ kind: s.kind, source: s.source, tokens: estimateTokens(s.content) })),
    dropped,
  });

  return {
    systemBlocks,
    fingerprint,
    totalTokens: used,
    includedSegments: included.map(s => ({
      kind: s.kind, tokens: estimateTokens(s.content), tier: TIER[s.kind],
    })),
    droppedSegments: dropped,
  };
}

// =================== HELPERS ===================

// Build a segment with sensible defaults. Most callers should use the builders
// in prompt-segments.ts rather than calling this directly.
export function segment(
  kind: SegmentKind,
  content: string,
  opts: Partial<Omit<PromptSegment, "kind" | "content">> = {},
): PromptSegment {
  return {
    kind, content,
    priority: opts.priority ?? 50,
    required: opts.required,
    source: opts.source || `${kind}/anonymous`,
    version: opts.version ?? 1,
  };
}
