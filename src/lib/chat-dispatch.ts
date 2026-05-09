// P58 + P59 — Per-provider chat-turn runners.
//
// The /api/chat route delegates to one of these based on the user's
// provider mode. Each runner takes the same shape (system prompt +
// messages + tool defs + an SSE emitter) and emits compatible events:
//
//   { type: "delta", text }
//   { type: "tool_use", name, args }
//   { type: "tool_result", result }
//   { type: "approval", ... } (Codex only)
//   { type: "log", level, message }
//   { type: "error", message }
//
// The Anthropic path stays in /api/chat/route.ts because it carries
// HyperAgent-specific extras (cache_control, plan mode, prompt cache
// stats). OpenAI now uses runOpenAILoop which DOES iterate tool calls
// server-side with full agent semantics (P59).

import type { UnifiedMessage } from "./llm-providers";
import { runOpenAILoop } from "./openai-loop";
import { runCodexTurn } from "./codex/chat-bridge";
import type { CodexBridgeConfig } from "./codex/types";
import type { ToolCtx } from "./tools";

export interface DispatchSend {
  (event: any): void;
}

// ─── OpenAI runner ───────────────────────────────────────────────────
//
// P59 — switched from single-pass streamChat to runOpenAILoop. Now does
// real agent loop semantics: each iteration may call tools, server-side
// executes them, appends `role: "tool"` messages, and re-calls until the
// model returns a final answer (or hits the iteration cap).

export interface OpenAITurnInput {
  userId: string;
  modelId: string;
  system: string;
  messages: UnifiedMessage[];
  tools: Array<{ name: string; description: string; input_schema: any }>;
  // P59 — required for server-side tool execution.
  toolCtx: ToolCtx;
  composioToolNames: Set<string>;
  builtinTools: any[];
  send: DispatchSend;
  maxIterations?: number;
}

export interface TurnResult {
  text: string;
  toolUses: { name: string; args: any }[];
  artifactIds: string[];
  inputTokens: number;
  outputTokens: number;
  errored: boolean;
  errorMessage?: string;
}

export async function runOpenAITurn(input: OpenAITurnInput): Promise<TurnResult> {
  // The loop handles its own error propagation + SSE emission.
  const r = await runOpenAILoop({
    userId: input.userId,
    modelId: input.modelId,
    system: input.system,
    // The unified message shape only carries user/assistant; the loop
    // re-shapes it into OpenAI's role enum.
    messages: input.messages.filter(m => m.role !== "system") as Array<{ role: "user" | "assistant"; content: string }>,
    tools: input.tools,
    toolCtx: input.toolCtx,
    composioToolNames: input.composioToolNames,
    builtinTools: input.builtinTools,
    send: input.send,
    maxIterations: input.maxIterations ?? 6,
  });
  return {
    text: r.text,
    toolUses: r.toolUses.map(t => ({ name: t.name, args: t.args })),
    artifactIds: r.artifactIds,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    errored: r.errored,
    errorMessage: r.errorMessage,
  };
}

// ─── Codex runner ────────────────────────────────────────────────────
//
// Delegates to runCodexTurn — bridge or stdio owns the conversation
// state and streams events back. We adapt to our SSE format.
//
// P64 — transport is provided explicitly:
//   "bridge"      — Phase 1, user-pasted bridge URL/token (bridge: arg required)
//   "local-stdio" — Phase 2, locally-spawned codex app-server (no bridge arg)
// Phase 3 is a browser-only path and doesn't reach this server function.

export interface CodexTurnInput {
  bridge?: CodexBridgeConfig;
  transport: "bridge" | "local-stdio";
  threadId: string;
  threadTitle?: string;
  input: string;
  userId: string;
  assistantMessageId: string;
  send: DispatchSend;
}

export interface CodexTurnResult extends TurnResult {
  // P59 — artifact ids the bridge produced (file changes, image outputs,
  // long-form tool results promoted into the canvas).
  artifactIds: string[];
}

export async function runCodexChatTurn(args: CodexTurnInput): Promise<CodexTurnResult> {
  const r = await runCodexTurn({
    transport: args.transport,
    bridge: args.bridge,
    threadId: args.threadId,
    threadTitle: args.threadTitle,
    input: args.input,
    userId: args.userId,
    assistantMessageId: args.assistantMessageId,
    send: args.send,
  });
  return {
    text: r.text,
    toolUses: r.toolUses.map(t => ({ name: t.name, args: t.args })),
    artifactIds: r.artifactIds,
    // Codex doesn't surface token counts the same way; we leave 0/0 so
    // the cost helper records "unbilled by us" and the user's ChatGPT
    // plan tracks real usage.
    inputTokens: 0,
    outputTokens: 0,
    errored: r.errored,
    errorMessage: r.errorMessage,
  };
}
