import Anthropic from "@anthropic-ai/sdk";
import { getModel } from "./models";
import { resolveSecret } from "./secrets";

// Per-user Anthropic client. Looks up the user's saved key first, then falls
// back to ANTHROPIC_API_KEY env var. Throws a helpful error if neither is set
// so we don't leak generic 401s to the chat UI.
export async function clientForUser(userId: string | null | undefined): Promise<Anthropic> {
  const apiKey = await resolveSecret(userId, "anthropic");
  if (!apiKey) throw new Error("Anthropic API key not configured. Add one in Settings → API Keys.");
  return new Anthropic({ apiKey });
}

// Back-compat for handlers that don't have a userId in scope yet
// (cron jobs, webhook fan-outs). Env-only.
export function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required (no user context to read user-scoped key)");
  return new Anthropic({ apiKey });
}

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

// Resolve a model id to an actual Anthropic call. For non-Anthropic models
// we fall back to the closest Anthropic equivalent — llm-providers.ts handles
// real cross-provider routing once the user has set up that provider.
export function resolveAnthropicModel(modelId: string): string {
  const m = getModel(modelId);
  if (m.provider === "anthropic") return m.id;
  if (modelId.startsWith("gpt-4o-mini")) return "claude-haiku-4-5-20250929";
  if (modelId.startsWith("gpt-4o") || modelId.startsWith("o1")) return "claude-sonnet-4-5-20250929";
  if (modelId.startsWith("gemini-2.5-flash")) return "claude-haiku-4-5-20250929";
  if (modelId.startsWith("gemini-2.5-pro")) return "claude-opus-4-5-20250929";
  return DEFAULT_MODEL;
}
