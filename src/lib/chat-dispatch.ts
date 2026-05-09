// P58 — Per-provider chat-turn runners.
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
// HyperAgent-specific extras (cache_control, multi-turn tool loop, plan
// mode, prompt cache stats). OpenAI + Codex are simpler one-shot paths.

import { streamChat, type UnifiedMessage } from "./llm-providers";
import { runCodexTurn } from "./codex/chat-bridge";
import type { CodexBridgeConfig } from "./codex/types";

export interface DispatchSend {
  (event: any): void;
}

// ─── OpenAI runner ───────────────────────────────────────────────────
//
// Routes through streamChat() which already implements function-calling
// over OpenAI Chat Completions SSE. Single iteration: we don't loop on
// tool calls server-side (the Anthropic path does). Tool calls surface
// as tool_use events; if the agent wanted to act on the result the user
// has to send a follow-up message. That matches the OpenAI Chat
// Completions usage pattern.

export interface OpenAITurnInput {
  userId: string;
  modelId: string;            // e.g. "gpt-4o" or "gpt-4o-mini"
  system: string;             // composed system prompt (no cache_control needed)
  messages: UnifiedMessage[]; // full message history this turn
  tools: Array<{ name: string; description: string; input_schema: any }>;
  send: DispatchSend;
}

export interface TurnResult {
  text: string;
  toolUses: { name: string; args: any }[];
  inputTokens: number;
  outputTokens: number;
  errored: boolean;
  errorMessage?: string;
}

export async function runOpenAITurn(input: OpenAITurnInput): Promise<TurnResult> {
  let text = "";
  const toolUses: { name: string; args: any }[] = [];
  let inputTokens = 0, outputTokens = 0;
  let errored = false;
  let errorMessage: string | undefined;
  try {
    const r = await streamChat({
      userId: input.userId,
      modelId: input.modelId,
      system: input.system,
      messages: input.messages,
      tools: input.tools,
      cb: {
        onText: delta => {
          text += delta;
          input.send({ type: "delta", text: delta });
        },
        onToolUse: tu => {
          toolUses.push({ name: tu.name, args: tu.input });
          input.send({ type: "tool_use", name: tu.name, args: tu.input });
        },
        onDone: info => {
          inputTokens = info.inputTokens;
          outputTokens = info.outputTokens;
        },
      },
    });
    inputTokens = r.inputTokens || inputTokens;
    outputTokens = r.outputTokens || outputTokens;
  } catch (e: any) {
    errored = true;
    errorMessage = e?.message || String(e);
    input.send({ type: "error", message: errorMessage });
  }
  return { text, toolUses, inputTokens, outputTokens, errored, errorMessage };
}

// ─── Codex runner ────────────────────────────────────────────────────
//
// Delegates to runCodexTurn — the bridge owns the conversation state and
// streams events back. We adapt to our SSE format.

export interface CodexTurnInput {
  bridge: CodexBridgeConfig;
  threadId: string;
  threadTitle?: string;
  input: string;
  send: DispatchSend;
}

export async function runCodexChatTurn(args: CodexTurnInput): Promise<TurnResult> {
  const r = await runCodexTurn({
    bridge: args.bridge,
    threadId: args.threadId,
    threadTitle: args.threadTitle,
    input: args.input,
    send: args.send,
  });
  return {
    text: r.text,
    toolUses: r.toolUses.map(t => ({ name: t.name, args: t.args })),
    // Codex doesn't surface token counts the same way; we leave 0/0 so
    // the cost helper records "unbilled by us" and the user's ChatGPT
    // plan tracks real usage.
    inputTokens: 0,
    outputTokens: 0,
    errored: r.errored,
    errorMessage: r.errorMessage,
  };
}
