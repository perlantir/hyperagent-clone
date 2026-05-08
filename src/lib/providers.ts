// P29 — Provider failover, error classification, retry logic.
//
// Three primitives that every chat/scheduler/v1-api call should pass through:
//
//   - classifyError(err): "transient" | "permanent" | "auth" | "rate_limit"
//     Determines whether to retry, fall over, or fail loudly.
//
//   - withRetry(fn, opts): Promise<T>
//     Same-provider retry with exponential backoff for transient errors.
//
//   - selectFallbackModel(currentModelId, requiredCapabilities)
//     Capability-matched alternative. NOT a blind "next provider in list."
//     A model is only an acceptable fallback if it satisfies the same
//     capability set the request needs (tools, json, vision, etc.).
//
// Cross-provider RUNTIME failover (translating Anthropic requests to OpenAI
// shape on the fly) is intentionally NOT wired in this push — the chat
// route streams via Anthropic SDK directly, and translating mid-stream is
// hairy. P29.5 will add a non-streaming unified call surface that uses these
// primitives end-to-end. For now: same-provider retry handles the 95% case
// (Anthropic 529 overloaded transient errors), and the capability selection
// is wired so future cross-provider routing is one wrapper away.

import { MODELS, getModel, type ModelCapabilities, type ModelInfo } from "./models";

// =================== ERROR CLASSIFICATION ===================

export type ErrorClass = "transient" | "permanent" | "auth" | "rate_limit" | "unknown";

export interface ClassifiedError {
  class: ErrorClass;
  retryable: boolean;
  reason: string;
  status?: number;
}

export function classifyError(err: any): ClassifiedError {
  // Try common shapes: Anthropic SDK errors, OpenAI SDK errors, raw fetch responses, generic Error
  const status: number | undefined =
    err?.status || err?.statusCode || err?.response?.status || err?.cause?.status;
  const message = (err?.message || String(err) || "").toLowerCase();

  // Auth errors — never retry, surface plainly. User needs to fix their key.
  if (status === 401 || status === 403 ||
      /invalid api key|unauthorized|authentication|invalid_api_key/i.test(message)) {
    return { class: "auth", retryable: false, reason: "invalid or missing API key", status };
  }

  // Rate limits — retry with backoff respecting Retry-After if present
  if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
    return { class: "rate_limit", retryable: true, reason: "rate limited", status };
  }

  // Anthropic 529 = overloaded; OpenAI/Gemini equivalent shows up as 503 or 502 sometimes
  if (status === 529 || status === 503 || status === 502 || status === 504) {
    return { class: "transient", retryable: true, reason: `provider ${status}`, status };
  }

  // 500s are usually retryable but might indicate a deeper issue. Retry once.
  if (status && status >= 500 && status < 600) {
    return { class: "transient", retryable: true, reason: `server ${status}`, status };
  }

  // Network-layer transients
  if (/econnreset|etimedout|enotfound|fetch failed|socket hang up|network error|timeout/i.test(message)) {
    return { class: "transient", retryable: true, reason: "network error" };
  }

  // 400-class — usually our fault (malformed request, context overflow, etc.)
  // Most are NOT retryable. Context overflow is the one exception caller might want to handle.
  if (status && status >= 400 && status < 500) {
    if (/context.{0,20}length|too many tokens|maximum context/i.test(message)) {
      return { class: "permanent", retryable: false, reason: "context overflow", status };
    }
    return { class: "permanent", retryable: false, reason: `client ${status}`, status };
  }

  return { class: "unknown", retryable: false, reason: message.slice(0, 200) || "unknown" };
}

// =================== RETRY ===================

export interface RetryOptions {
  maxAttempts?: number;            // including the first try (default 3)
  baseDelayMs?: number;            // initial backoff (default 500)
  maxDelayMs?: number;              // cap (default 8000)
  onRetry?: (attempt: number, err: ClassifiedError, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 8000;
  let lastErr: any;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const classified = classifyError(err);
      if (!classified.retryable || attempt === max) throw err;
      const delay = Math.min(cap, base * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250);
      opts.onRetry?.(attempt, classified, delay);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// =================== CAPABILITY SELECTION ===================

// Required capabilities for a request. Pass only the booleans you need.
export interface RequiredCapabilities {
  tools?: boolean;
  json?: boolean;
  vision?: boolean;
  streaming?: boolean;
  longContext?: boolean;
  minReasoning?: "fast" | "balanced" | "deep";
}

const REASONING_RANK: Record<ModelCapabilities["reasoning"], number> = {
  fast: 0, balanced: 1, deep: 2,
};

// Inspect a request to figure out what capabilities it needs. Used as a
// convenience before calling selectFallbackModel.
export function inferRequiredCapabilities(args: {
  hasTools?: boolean;
  needsJson?: boolean;
  hasVisionInput?: boolean;
  isStreaming?: boolean;
  estimatedInputTokens?: number;
}): RequiredCapabilities {
  return {
    tools: args.hasTools ?? false,
    json: args.needsJson ?? false,
    vision: args.hasVisionInput ?? false,
    streaming: args.isStreaming ?? false,
    longContext: (args.estimatedInputTokens ?? 0) > 100_000,
  };
}

export function modelSatisfies(model: ModelInfo, required: RequiredCapabilities): boolean {
  const cap = model.capabilities;
  if (required.tools && !cap.tools) return false;
  if (required.json && !cap.json) return false;
  if (required.vision && !cap.vision) return false;
  if (required.streaming && !cap.streaming) return false;
  if (required.longContext && !cap.longContext) return false;
  if (required.minReasoning && REASONING_RANK[cap.reasoning] < REASONING_RANK[required.minReasoning]) return false;
  return true;
}

// Pick a fallback model that satisfies the required capabilities, preferring:
//   1. Same provider (fewer surprises in tool-call shape, JSON behavior)
//   2. Closer in price/performance tier
//   3. Different provider as last resort
export function selectFallbackModel(
  currentModelId: string,
  required: RequiredCapabilities,
  exclude: Set<string> = new Set(),
): ModelInfo | null {
  const current = getModel(currentModelId);
  exclude.add(currentModelId);

  // Pass 1: same provider, same reasoning tier
  for (const m of MODELS) {
    if (exclude.has(m.id)) continue;
    if (m.provider !== current.provider) continue;
    if (m.capabilities.reasoning !== current.capabilities.reasoning) continue;
    if (modelSatisfies(m, required)) return m;
  }

  // Pass 2: same provider, any reasoning tier (prefer cheaper)
  const sameProvider = MODELS
    .filter(m => !exclude.has(m.id) && m.provider === current.provider)
    .filter(m => modelSatisfies(m, required))
    .sort((a, b) => a.inputPer1k + a.outputPer1k - (b.inputPer1k + b.outputPer1k));
  if (sameProvider[0]) return sameProvider[0];

  // Pass 3: any provider that satisfies (capability-based, not provider-based)
  const anyProvider = MODELS
    .filter(m => !exclude.has(m.id))
    .filter(m => modelSatisfies(m, required))
    .sort((a, b) => a.inputPer1k + a.outputPer1k - (b.inputPer1k + b.outputPer1k));
  return anyProvider[0] || null;
}

// =================== LOOP DETECTION ===================

// Detect when an iterative tool loop has stalled — same tools called with
// same args repeatedly with no new text generated. Caller passes the per-iter
// signature; this returns true when the last N iterations were identical.

export function detectLoop(
  history: Array<{ text: string; toolSig: string }>,
  threshold = 3,
): boolean {
  if (history.length < threshold) return false;
  const last = history.slice(-threshold);
  const allSameSig = last.every(h => h.toolSig === last[0].toolSig);
  const allEmptyText = last.every(h => h.text.trim().length === 0);
  return allSameSig && allEmptyText && last[0].toolSig.length > 0;
}

// =================== CONTEXT-OVERFLOW TRUNCATION ===================

// When `messages` would exceed the model's context window, truncate from the
// middle outward, preserving:
//   1. The original user message (first message)
//   2. The most recent N turns (last assistant + tool_results + user_message)
// Drop the middle (older tool_results, older assistant turns). Never drop
// the user message — that's the active task.
//
// Returns truncated messages and a count of what was removed.

export function truncateMessages(
  messages: any[],
  maxApproxTokens: number,
): { messages: any[]; dropped: number } {
  // Quick estimate: avg 4 chars per token
  const approxTokens = (m: any) => {
    if (typeof m.content === "string") return Math.ceil(m.content.length / 4);
    if (Array.isArray(m.content)) {
      let n = 0;
      for (const b of m.content) {
        if (typeof b === "string") n += Math.ceil(b.length / 4);
        else if (b?.text) n += Math.ceil(b.text.length / 4);
        else if (b?.content) n += Math.ceil(JSON.stringify(b.content).length / 4);
        else n += 50; // tool_use blocks etc.
      }
      return n;
    }
    return 100;
  };

  let total = messages.reduce((s, m) => s + approxTokens(m), 0);
  if (total <= maxApproxTokens) return { messages, dropped: 0 };

  // Always keep first user message and last 4 messages
  const head = messages.slice(0, 1);
  const tail = messages.slice(-4);
  const middle = messages.slice(1, -4);

  // Drop middle messages from the front until under budget
  let dropped = 0;
  while (middle.length > 0) {
    const headTokens = head.reduce((s, m) => s + approxTokens(m), 0);
    const tailTokens = tail.reduce((s, m) => s + approxTokens(m), 0);
    const middleTokens = middle.reduce((s, m) => s + approxTokens(m), 0);
    if (headTokens + middleTokens + tailTokens <= maxApproxTokens) break;
    middle.shift();
    dropped++;
  }

  return {
    messages: [...head, ...middle, ...tail],
    dropped,
  };
}
