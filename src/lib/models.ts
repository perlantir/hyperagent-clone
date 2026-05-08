// Multi-provider LLM model registry.
// Each model has a provider (anthropic/openai/google), id (used in API call),
// label (display), context window, per-1k token pricing, and a capability
// fingerprint used by the failover layer to pick compatible alternatives.

export type Provider = "anthropic" | "openai" | "google";

export interface ModelCapabilities {
  tools: boolean;          // function/tool calling
  json: boolean;           // structured JSON output mode
  vision: boolean;         // image understanding
  streaming: boolean;      // SSE streaming responses
  longContext: boolean;    // ≥128k tokens
  reasoning: "fast" | "balanced" | "deep"; // perceived reasoning depth
  promptCaching: boolean;  // server-side prompt prefix caching
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: Provider;
  contextWindow: number;
  inputPer1k: number;
  outputPer1k: number;
  supportsTools: boolean;       // legacy; kept for back-compat with settings UI
  supportsVision: boolean;
  capabilities: ModelCapabilities;
}

export const MODELS: ModelInfo[] = [
  // ============ Anthropic ============
  {
    id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5", provider: "anthropic",
    contextWindow: 200_000, inputPer1k: 3, outputPer1k: 15,
    supportsTools: true, supportsVision: true,
    capabilities: { tools: true, json: true, vision: true, streaming: true, longContext: true, reasoning: "balanced", promptCaching: true },
  },
  {
    id: "claude-opus-4-5-20250929", label: "Claude Opus 4.5", provider: "anthropic",
    contextWindow: 200_000, inputPer1k: 15, outputPer1k: 75,
    supportsTools: true, supportsVision: true,
    capabilities: { tools: true, json: true, vision: true, streaming: true, longContext: true, reasoning: "deep", promptCaching: true },
  },
  {
    id: "claude-haiku-4-5-20250929", label: "Claude Haiku 4.5", provider: "anthropic",
    contextWindow: 200_000, inputPer1k: 1, outputPer1k: 5,
    supportsTools: true, supportsVision: true,
    capabilities: { tools: true, json: true, vision: true, streaming: true, longContext: true, reasoning: "fast", promptCaching: true },
  },
  // ============ OpenAI ============
  {
    id: "gpt-4o", label: "GPT-4o", provider: "openai",
    contextWindow: 128_000, inputPer1k: 2.5, outputPer1k: 10,
    supportsTools: true, supportsVision: true,
    capabilities: { tools: true, json: true, vision: true, streaming: true, longContext: true, reasoning: "balanced", promptCaching: true },
  },
  {
    id: "gpt-4o-mini", label: "GPT-4o mini", provider: "openai",
    contextWindow: 128_000, inputPer1k: 0.15, outputPer1k: 0.6,
    supportsTools: true, supportsVision: true,
    capabilities: { tools: true, json: true, vision: true, streaming: true, longContext: true, reasoning: "fast", promptCaching: true },
  },
  {
    // o1 doesn't support tools or vision and uses a different streaming model
    id: "o1-preview", label: "OpenAI o1", provider: "openai",
    contextWindow: 128_000, inputPer1k: 15, outputPer1k: 60,
    supportsTools: false, supportsVision: false,
    capabilities: { tools: false, json: false, vision: false, streaming: false, longContext: true, reasoning: "deep", promptCaching: false },
  },
  // ============ Google ============
  {
    id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google",
    contextWindow: 2_000_000, inputPer1k: 1.25, outputPer1k: 5,
    supportsTools: true, supportsVision: true,
    capabilities: { tools: true, json: true, vision: true, streaming: true, longContext: true, reasoning: "balanced", promptCaching: true },
  },
  {
    id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google",
    contextWindow: 1_000_000, inputPer1k: 0.075, outputPer1k: 0.3,
    supportsTools: true, supportsVision: true,
    capabilities: { tools: true, json: true, vision: true, streaming: true, longContext: true, reasoning: "fast", promptCaching: false },
  },
];

export const DEFAULT_MODEL_ID = "claude-sonnet-4-5-20250929";

export function getModel(id: string): ModelInfo {
  return MODELS.find(m => m.id === id) || MODELS[0];
}

export function modelsByProvider() {
  const groups: Record<Provider, ModelInfo[]> = { anthropic: [], openai: [], google: [] };
  for (const m of MODELS) groups[m.provider].push(m);
  return groups;
}
