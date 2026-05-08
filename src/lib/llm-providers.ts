// Real multi-provider chat dispatch.
// Today the chat route always streamed via Anthropic. This module adds first-
// class OpenAI and Gemini paths and emits a unified event stream so the UI
// renders identically regardless of which model was picked.

import Anthropic from "@anthropic-ai/sdk";
import { getModel } from "./models";
import { resolveSecret } from "./secrets";

export interface UnifiedMessage { role: "user" | "assistant" | "system"; content: string; }

export interface StreamCallbacks {
  onText: (delta: string) => void;
  onToolUse?: (block: { id: string; name: string; input: any }) => void;
  onDone?: (info: { inputTokens: number; outputTokens: number; toolUses: { id: string; name: string; input: any }[] }) => void;
}

async function ant(userId: string | null | undefined) {
  const k = await resolveSecret(userId, "anthropic");
  if (!k) throw new Error("Anthropic API key not configured. Add one in Settings → API Keys.");
  return new Anthropic({ apiKey: k });
}

async function openaiKey(userId: string | null | undefined) {
  const k = await resolveSecret(userId, "openai");
  if (!k) throw new Error("OpenAI API key not configured. Add one in Settings → API Keys.");
  return k;
}
async function geminiKey(userId: string | null | undefined) {
  const k = await resolveSecret(userId, "gemini");
  if (!k) throw new Error("Gemini API key not configured. Add one in Settings → API Keys.");
  return k;
}

export async function streamChat(args: {
  userId?: string | null;
  modelId: string;
  system: string;
  messages: UnifiedMessage[];
  tools: Array<{ name: string; description: string; input_schema: any }>;
  cb: StreamCallbacks;
}) {
  const m = getModel(args.modelId);
  if (m.provider === "anthropic") return await streamAnthropic(args);
  if (m.provider === "openai") return await streamOpenAI(args);
  if (m.provider === "google") return await streamGoogle(args);
  throw new Error(`Unknown provider: ${m.provider}`);
}

// =========== ANTHROPIC ===========
async function streamAnthropic(a: any) {
  const client = await ant(a.userId);
  const stream = client.messages.stream({
    model: a.modelId,
    max_tokens: 2048,
    system: a.system,
    messages: a.messages,
    tools: a.tools as any,
  });
  const toolUses: { id: string; name: string; input: any }[] = [];
  let inputTokens = 0, outputTokens = 0;
  for await (const event of stream as any) {
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      toolUses.push({ id: event.content_block.id, name: event.content_block.name, input: {} });
    }
    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") a.cb.onText(event.delta.text);
      else if (event.delta.type === "input_json_delta") {
        const last = toolUses[toolUses.length - 1];
        if (last) (last as any)._partial = ((last as any)._partial || "") + event.delta.partial_json;
      }
    }
  }
  const final = await (stream as any).finalMessage();
  inputTokens = final.usage?.input_tokens || 0;
  outputTokens = final.usage?.output_tokens || 0;
  for (const tu of toolUses) {
    try { tu.input = (tu as any)._partial ? JSON.parse((tu as any)._partial) : {}; } catch { tu.input = {}; }
    a.cb.onToolUse?.(tu);
  }
  a.cb.onDone?.({ inputTokens, outputTokens, toolUses });
  return { toolUses, inputTokens, outputTokens };
}

// =========== OPENAI ===========
async function streamOpenAI(a: any) {
  // Convert tools to OpenAI function-calling format
  const tools = a.tools.map((t: any) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  const messages = [
    { role: "system", content: a.system },
    ...a.messages.map((m: any) => ({ role: m.role, content: m.content })),
  ];
  const oaKey = await openaiKey(a.userId);
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${oaKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: a.modelId, messages, tools, stream: true }),
  });
  if (!r.ok || !r.body) throw new Error(`OpenAI stream error: ${r.status} ${await r.text()}`);

  const toolUses: { id: string; name: string; input: any }[] = [];
  const toolBuffers: Record<number, { id: string; name: string; argsBuffer: string }> = {};
  let inputTokens = 0, outputTokens = 0;
  const reader = r.body.getReader();
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
      try {
        const ev = JSON.parse(data);
        const choice = ev.choices?.[0];
        if (choice?.delta?.content) a.cb.onText(choice.delta.content);
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolBuffers[idx]) toolBuffers[idx] = { id: tc.id || `tu_${idx}`, name: tc.function?.name || "", argsBuffer: "" };
            if (tc.function?.name) toolBuffers[idx].name = tc.function.name;
            if (tc.function?.arguments) toolBuffers[idx].argsBuffer += tc.function.arguments;
          }
        }
        if (ev.usage) {
          inputTokens = ev.usage.prompt_tokens || 0;
          outputTokens = ev.usage.completion_tokens || 0;
        }
      } catch {}
    }
  }
  for (const idx of Object.keys(toolBuffers)) {
    const b = toolBuffers[+idx];
    let parsed: any = {};
    try { parsed = b.argsBuffer ? JSON.parse(b.argsBuffer) : {}; } catch {}
    const tu = { id: b.id, name: b.name, input: parsed };
    toolUses.push(tu);
    a.cb.onToolUse?.(tu);
  }
  a.cb.onDone?.({ inputTokens, outputTokens, toolUses });
  return { toolUses, inputTokens, outputTokens };
}

// =========== GOOGLE GEMINI ===========
async function streamGoogle(a: any) {
  // Convert tools to Gemini format
  const tools = a.tools.length
    ? [{ functionDeclarations: a.tools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }]
    : undefined;
  const contents = a.messages.map((m: any) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const gKey = await geminiKey(a.userId);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${a.modelId}:streamGenerateContent?alt=sse&key=${gKey}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: a.system }] }, tools }),
  });
  if (!r.ok || !r.body) throw new Error(`Gemini stream error: ${r.status} ${await r.text()}`);

  const toolUses: { id: string; name: string; input: any }[] = [];
  let inputTokens = 0, outputTokens = 0;
  const reader = r.body.getReader();
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
      try {
        const ev = JSON.parse(data);
        const candidates = ev.candidates || [];
        for (const c of candidates) {
          const blocks = c.content?.parts || [];
          for (const blk of blocks) {
            if (blk.text) a.cb.onText(blk.text);
            if (blk.functionCall) {
              const tu = { id: `tu_${toolUses.length}`, name: blk.functionCall.name, input: blk.functionCall.args || {} };
              toolUses.push(tu);
              a.cb.onToolUse?.(tu);
            }
          }
        }
        if (ev.usageMetadata) {
          inputTokens = ev.usageMetadata.promptTokenCount || 0;
          outputTokens = ev.usageMetadata.candidatesTokenCount || 0;
        }
      } catch {}
    }
  }
  a.cb.onDone?.({ inputTokens, outputTokens, toolUses });
  return { toolUses, inputTokens, outputTokens };
}
