import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;
export function client() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  _client = new Anthropic({ apiKey });
  return _client;
}

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
