// The big one — streaming chat with tool calling, memory, multi-agent routing,
// and credit accounting.
//
// Body: { threadId: string, content: string, useRouter?: boolean }
// Returns: text/event-stream with JSON events (delta, tool_use, tool_result,
//   artifact, router, done, error).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  getThread, listMessages, createMessage, updateMessage, updateThread,
  getAgent, listAgents,
} from "@/lib/db";
import { clientForUser, DEFAULT_MODEL } from "@/lib/llm";
import { resolveAllTools, executeAnyTool, ToolCtx } from "@/lib/tools";
import { memoriesForContext, memoriesAsSystemBlock } from "@/lib/memory";
import { routeMessage } from "@/lib/router";
import { balance, chargeCredits, computeCost } from "@/lib/credits";
// Note: scheduler is now driven by Vercel Cron at /api/cron, no in-process loop.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Scheduler is now Vercel Cron at /api/cron — no in-process boot needed.

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { threadId, content, useRouter } = await req.json().catch(() => ({}));
  if (!threadId || !content) return NextResponse.json({ error: "threadId and content required" }, { status: 400 });

  const thread = await getThread(threadId, user.id);
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  if (await balance(user.id) <= 0) return NextResponse.json({ error: "out of credits" }, { status: 402 });

  // Save user message.
  await createMessage({ threadId, role: "user", content });
  if ((await listMessages(threadId)).filter(m => m.role === "user").length === 1) {
    // First user message → use it as title (truncated).
    await updateThread(threadId, user.id, { title: content.slice(0, 60) });
  }

  // Smart routing: if useRouter is true and thread has no agent, pick one.
  let agentId = thread.agentId;
  let routerNote: { agentId: string; reason: string } | null = null;
  if (useRouter && !agentId) {
    const agents = (await listAgents(user.id)).filter(a => a.name.toLowerCase() !== "router");
    try {
      const decision = await routeMessage(content, agents, user.id);
      agentId = decision.agentId;
      routerNote = decision;
      await updateThread(threadId, user.id, { agentId });
    } catch (e) {
      console.error("[router]", e);
    }
  }

  const agent = agentId ? await getAgent(agentId, user.id) : null;

  // Build system prompt.
  const memories = await memoriesForContext(user.id, agent?.id ?? null, thread.projectId);
  const systemPrompt = (agent?.systemPrompt || "You are a helpful AI assistant.") + memoriesAsSystemBlock(memories);

  // Resolve tools.
  const toolNames = agent?.tools?.length ? agent.tools : ["web_search", "generate_artifact"];
  const { tools, composioToolNames, builtinTools } = await resolveAllTools(user.id, toolNames);

  // Build the conversation history for Anthropic.
  const allMsgs = await listMessages(threadId);
  const anthropicMessages: any[] = [];
  for (const m of allMsgs) {
    if (m.role === "user") anthropicMessages.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && m.content) {
      anthropicMessages.push({ role: "assistant", content: m.content });
    }
  }
  // Last message in DB is the user message we just stored — anthropicMessages already includes it.

  // Create the assistant message shell that we'll accumulate into.
  const assistantMsg = await createMessage({ threadId, role: "assistant", content: "" });
  const ctx: ToolCtx = { userId: user.id, threadId, messageId: assistantMsg.id, artifactsCreated: [] };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: any) {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch {}
      }
      try {
        if (routerNote) send({ type: "router", chosenAgentId: routerNote.agentId, reason: routerNote.reason });

        let accumulatedText = "";
        const toolCallsPersisted: { name: string; args: any; result?: string; durationMs?: number }[] = [];
        const artifactIds: string[] = [];
        let totalIn = 0, totalOut = 0;

        // Iterative tool-calling loop. Each iteration may produce text + zero or more tool_use blocks.
        let messages = anthropicMessages.slice();
        const ant = await clientForUser(user.id);
        for (let iter = 0; iter < 6; iter++) {
          const stream2 = ant.messages.stream({
            model: DEFAULT_MODEL,
            max_tokens: 2048,
            system: systemPrompt,
            messages,
            tools: tools as any,
          });

          // Collect tool_use blocks emitted in this turn.
          const turnToolUses: { id: string; name: string; input: any }[] = [];
          let turnText = "";

          for await (const event of stream2) {
            if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
              turnToolUses.push({ id: event.content_block.id, name: event.content_block.name, input: {} });
            }
            if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                const piece = event.delta.text;
                turnText += piece;
                accumulatedText += piece;
                send({ type: "delta", text: piece });
              } else if (event.delta.type === "input_json_delta") {
                const last = turnToolUses[turnToolUses.length - 1];
                if (last) (last as any)._partial = ((last as any)._partial || "") + event.delta.partial_json;
              }
            }
          }
          const final = await stream2.finalMessage();
          totalIn += final.usage?.input_tokens || 0;
          totalOut += final.usage?.output_tokens || 0;

          // Resolve tool_use partials into JSON.
          for (const tu of turnToolUses) {
            try { tu.input = (tu as any)._partial ? JSON.parse((tu as any)._partial) : {}; }
            catch { tu.input = {}; }
          }

          // If no tool calls this turn, we're done.
          if (turnToolUses.length === 0) {
            // Keep messages history intact.
            break;
          }

          // Otherwise execute each tool and append a tool_result block, then continue the loop.
          send({ type: "delta", text: "" }); // ping

          // Append the assistant turn to the messages array (text + tool_use blocks).
          const assistantBlocks: any[] = [];
          if (turnText) assistantBlocks.push({ type: "text", text: turnText });
          for (const tu of turnToolUses) assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
          messages.push({ role: "assistant", content: assistantBlocks });

          const toolResults: any[] = [];
          for (const tu of turnToolUses) {
            send({ type: "tool_use", name: tu.name, input: tu.input, id: tu.id });
            const t0 = Date.now();
            const result = await executeAnyTool(tu.name, tu.input, ctx, composioToolNames, builtinTools);
            const dt = Date.now() - t0;
            send({ type: "tool_result", id: tu.id, result, durationMs: dt });
            toolCallsPersisted.push({ name: tu.name, args: tu.input, result, durationMs: dt });
            toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
          }
          messages.push({ role: "user", content: toolResults });

          // Forward any artifacts created by tools.
          for (const a of ctx.artifactsCreated) {
            if (!artifactIds.includes(a.id)) {
              artifactIds.push(a.id);
              send({ type: "artifact", artifactId: a.id, title: a.title, artifactType: a.type });
            }
          }
        }

        // Persist the final assistant message.
        const cost = await computeCost(totalIn, totalOut);
        await updateMessage(assistantMsg.id, {
          content: accumulatedText,
          toolCalls: toolCallsPersisted,
          artifactIds,
          costCredits: cost,
        });
        await chargeCredits(user.id, cost, "Chat", assistantMsg.id);
        await updateThread(threadId, user.id, { updatedAt: Date.now() });

        send({ type: "done", messageId: assistantMsg.id, costCredits: cost });
        controller.close();
      } catch (e: any) {
        console.error("[chat]", e);
        try { send({ type: "error", message: e?.message || String(e) }); } catch {}
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}
