// P59 — OpenAI multi-turn tool loop.
//
// The single-pass runOpenAITurn shipped in P58 surfaced function calls
// in the UI but never iterated server-side. This loop mirrors the
// Anthropic tool loop: each iteration calls the OpenAI API, executes
// any tool calls server-side, appends the tool messages to the
// conversation, and re-calls until either the model returns a final
// answer or we hit the iteration cap.
//
// Differences from the Anthropic loop:
//   - OpenAI's message format uses `role: "tool"` rather than tool_result
//     content blocks. We track an explicit OpenAI message array.
//   - No prompt cache breakpoints (OpenAI caches automatically).
//   - We don't dispatch sub-agents (Anthropic-only) but tool_use events
//     for any builtin / Composio tool work the same way.
//   - SSE event shape is identical to the Anthropic path so the chat UI
//     renders both providers uniformly.

import { resolveSecret } from "./secrets";
import { executeAnyTool, type ToolCtx } from "./tools";

export interface OpenAILoopMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  // Used on assistant messages that called tools.
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  // Used on tool messages so OpenAI can correlate with the assistant
  // turn that called it.
  tool_call_id?: string;
  name?: string;
}

export interface OpenAILoopOptions {
  userId: string;
  modelId: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: Array<{ name: string; description: string; input_schema: any }>;
  // Tool execution context — same one passed to the Anthropic loop so
  // tool side-effects (artifact creation, memory saves, etc.) work
  // identically across providers.
  toolCtx: ToolCtx;
  composioToolNames: Set<string>;
  builtinTools: any[];
  send: (event: any) => void;
  // Per-iteration cap so a runaway model can't burn the budget.
  maxIterations?: number;
}

export interface OpenAILoopResult {
  text: string;
  toolUses: Array<{ name: string; args: any; result?: string }>;
  artifactIds: string[];
  inputTokens: number;
  outputTokens: number;
  errored: boolean;
  errorMessage?: string;
  iterations: number;
}

export async function runOpenAILoop(opts: OpenAILoopOptions): Promise<OpenAILoopResult> {
  const apiKey = await resolveSecret(opts.userId, "openai");
  if (!apiKey) {
    const msg = "OpenAI API key not configured. Add one in Settings → API Keys.";
    opts.send({ type: "error", message: msg });
    return {
      text: "", toolUses: [], artifactIds: [],
      inputTokens: 0, outputTokens: 0,
      errored: true, errorMessage: msg, iterations: 0,
    };
  }

  // Build the OpenAI messages array starting with system + the user
  // history. We append tool_calls / tool messages as we go.
  const messages: OpenAILoopMessage[] = [
    { role: "system", content: opts.system },
    ...opts.messages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  const fnTools = opts.tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const maxIters = opts.maxIterations ?? 6;
  let totalIn = 0, totalOut = 0;
  let accumulatedText = "";
  const toolUses: Array<{ name: string; args: any; result?: string }> = [];
  let iterations = 0;
  let errored = false;
  let errorMessage: string | undefined;

  for (let iter = 0; iter < maxIters; iter++) {
    iterations = iter + 1;
    let iterText = "";
    const iterToolBuffers: Record<number, { id: string; name: string; argsBuffer: string }> = {};

    let resp: Response;
    try {
      resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: opts.modelId,
          messages,
          tools: fnTools.length ? fnTools : undefined,
          stream: true,
        }),
      });
    } catch (e: any) {
      errored = true;
      errorMessage = e?.message || String(e);
      opts.send({ type: "error", message: errorMessage });
      break;
    }
    if (!resp.ok || !resp.body) {
      const t = await resp.text().catch(() => "");
      errored = true;
      errorMessage = `OpenAI ${resp.status}: ${t.slice(0, 240)}`;
      opts.send({ type: "error", message: errorMessage });
      break;
    }

    // Stream-parse SSE.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        const data = part.slice(6).trim();
        if (data === "[DONE]") continue;
        let ev: any;
        try { ev = JSON.parse(data); } catch { continue; }
        const choice = ev.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          iterText += delta.content;
          accumulatedText += delta.content;
          opts.send({ type: "delta", text: delta.content });
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!iterToolBuffers[idx]) {
              iterToolBuffers[idx] = {
                id: tc.id || `call_${idx}_${Date.now()}`,
                name: tc.function?.name || "",
                argsBuffer: "",
              };
            }
            if (tc.id) iterToolBuffers[idx].id = tc.id;
            if (tc.function?.name) iterToolBuffers[idx].name = tc.function.name;
            if (tc.function?.arguments) iterToolBuffers[idx].argsBuffer += tc.function.arguments;
          }
        }
        if (ev.usage) {
          totalIn += ev.usage.prompt_tokens || 0;
          totalOut += ev.usage.completion_tokens || 0;
        }
      }
    }

    const turnToolCalls = Object.values(iterToolBuffers);
    if (turnToolCalls.length === 0) {
      // Final iteration — the model produced text only, we're done.
      break;
    }

    // Append the assistant message with its tool calls.
    messages.push({
      role: "assistant",
      content: iterText || null,
      tool_calls: turnToolCalls.map(tc => ({
        id: tc.id, type: "function" as const,
        function: { name: tc.name, arguments: tc.argsBuffer || "{}" },
      })),
    });

    // Execute each tool call and append a `role: "tool"` message back.
    for (const tc of turnToolCalls) {
      let args: any = {};
      try { args = tc.argsBuffer ? JSON.parse(tc.argsBuffer) : {}; } catch {}
      opts.send({ type: "tool_use", id: tc.id, name: tc.name, args });

      let result: string;
      try {
        result = await executeAnyTool(tc.name, args, opts.toolCtx, opts.composioToolNames, opts.builtinTools);
      } catch (e: any) {
        result = `Error: ${e?.message || String(e)}`;
      }
      // The tool may have created artifacts; pick those up so they
      // attach to this turn's message in the chat UI.
      // (toolCtx.artifactsCreated is appended-to in-place by executeAnyTool.)
      toolUses.push({ name: tc.name, args, result });
      opts.send({ type: "tool_result", id: tc.id, result });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.name,
        content: result,
      });
    }
    // Loop again: model gets to react to the tool results.
  }

  if (iterations >= maxIters) {
    opts.send({
      type: "log", level: "warn",
      message: `OpenAI loop hit iteration cap (${maxIters}); stopping.`,
    });
  }

  const artifactIds = (opts.toolCtx.artifactsCreated || []).map(a => a.id);

  return {
    text: accumulatedText,
    toolUses,
    artifactIds,
    inputTokens: totalIn,
    outputTokens: totalOut,
    errored,
    errorMessage,
    iterations,
  };
}
