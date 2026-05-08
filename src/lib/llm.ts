import Anthropic from "@anthropic-ai/sdk";
import { getModel, MODELS } from "./models";

let _client: Anthropic | null = null;
export function client() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  _client = new Anthropic({ apiKey });
  return _client;
}

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

// Resolve a model id to an actual Anthropic call. For non-Anthropic models
// we fall back to the closest Anthropic equivalent for now (Phase 16 will
// wire real OpenAI / Google providers).
export function resolveAnthropicModel(modelId: string): string {
  const m = getModel(modelId);
  if (m.provider === "anthropic") return m.id;
  // Fallback mapping until multi-provider is wired
  if (modelId.startsWith("gpt-4o-mini")) return "claude-haiku-4-5-20250929";
  if (modelId.startsWith("gpt-4o") || modelId.startsWith("o1")) return "claude-sonnet-4-5-20250929";
  if (modelId.startsWith("gemini-2.5-flash")) return "claude-haiku-4-5-20250929";
  if (modelId.startsWith("gemini-2.5-pro")) return "claude-opus-4-5-20250929";
  return DEFAULT_MODEL;
}
