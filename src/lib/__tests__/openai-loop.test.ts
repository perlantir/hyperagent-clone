// P59 — OpenAI multi-turn tool loop tests.
//
// Validates:
//   - Single-pass turn with no tool calls returns the streamed text
//   - Tool call → server-side execution → re-call until model returns
//     a final answer (the actual agent loop)
//   - Iteration cap honored (loop bails after maxIterations)
//   - Missing API key → errored result + error SSE event
//   - Token usage accumulates across iterations
//   - artifactIds collected from toolCtx.artifactsCreated

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// ─── stub resolveSecret + executeAnyTool BEFORE importing openai-loop ──

const secretsPath = require.resolve("../secrets");
let nextApiKey: string | null = "sk-test-1234567890";
(require as any).cache[secretsPath] = {
  id: secretsPath, filename: secretsPath, loaded: true,
  exports: { resolveSecret: async () => nextApiKey },
};

const toolsPath = require.resolve("../tools");
let toolExecutionLog: Array<{ name: string; args: any; result: string }> = [];
let nextToolResult: string = "";
(require as any).cache[toolsPath] = {
  id: toolsPath, filename: toolsPath, loaded: true,
  exports: {
    executeAnyTool: async (name: string, args: any, _ctx: any, _composio: any, _builtin: any) => {
      const result = nextToolResult;
      toolExecutionLog.push({ name, args, result });
      return result;
    },
  },
};

// ─── stub global fetch to simulate OpenAI's SSE response ───────────

interface FetchStub {
  /** What the next fetch() should respond with (multiple = sequential turns) */
  responses: Array<string[]>; // each inner array = SSE chunks for that response
  index: number;
  callsMade: any[];
}
const stub: FetchStub = { responses: [], index: 0, callsMade: [] };

const origFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async (url: string, init: any) => {
  stub.callsMade.push({ url, init });
  const chunks = stub.responses[stub.index] || [];
  stub.index++;
  // Build a ReadableStream that yields the SSE chunks then closes.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

const { runOpenAILoop } = require("../openai-loop");

function sse(obj: any): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function runScenario(opts: any) {
  stub.responses = opts.responses;
  stub.index = 0;
  stub.callsMade = [];
  toolExecutionLog = [];
  const sent: any[] = [];
  const r = await runOpenAILoop({
    userId: "u-test",
    modelId: "gpt-4o",
    system: "you are terse",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "search", description: "search web", input_schema: { type: "object" } }],
    toolCtx: { userId: "u-test", threadId: "t1", messageId: "m1", artifactsCreated: opts.artifacts || [] },
    composioToolNames: new Set(),
    builtinTools: [],
    send: (e: any) => sent.push(e),
    maxIterations: opts.maxIterations,
  });
  return { result: r, sent, calls: stub.callsMade };
}

(async () => {
  // ─── single-pass: no tool calls, just text ─────────────────────────
  {
    const { result, sent } = await runScenario({
      responses: [[
        sse({ choices: [{ delta: { content: "Hello! " } }] }),
        sse({ choices: [{ delta: { content: "How can I help?" } }] }),
        sse({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        "data: [DONE]\n\n",
      ]],
    });
    pass("single-pass returns full text",
      result.text === "Hello! How can I help?");
    pass("single-pass emits two delta events",
      sent.filter(e => e.type === "delta").length === 2);
    pass("single-pass tracks tokens",
      result.inputTokens === 10 && result.outputTokens === 5);
    pass("single-pass iterations === 1", result.iterations === 1);
    pass("single-pass not errored", result.errored === false);
    pass("single-pass executes zero tools", toolExecutionLog.length === 0);
  }

  // ─── multi-turn: tool call → re-call with tool result → final ──────
  {
    nextToolResult = "matched 3 results";
    const { result, sent, calls } = await runScenario({
      responses: [
        // First call: model emits a tool_call.
        [
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "{\"q\":\"foo\"}" } }] } }] }),
          sse({ usage: { prompt_tokens: 10, completion_tokens: 8 } }),
          "data: [DONE]\n\n",
        ],
        // Second call: model gets the tool result, returns final text.
        [
          sse({ choices: [{ delta: { content: "Found 3 things." } }] }),
          sse({ usage: { prompt_tokens: 30, completion_tokens: 4 } }),
          "data: [DONE]\n\n",
        ],
      ],
    });
    pass("multi-turn calls OpenAI twice",
      calls.length === 2);
    pass("multi-turn second call includes tool message",
      (() => {
        const body = JSON.parse(calls[1].init.body);
        const toolMsg = body.messages.find((m: any) => m.role === "tool");
        return !!toolMsg
          && toolMsg.content === "matched 3 results"
          && toolMsg.tool_call_id === "call_1";
      })());
    pass("multi-turn second call includes assistant tool_calls",
      (() => {
        const body = JSON.parse(calls[1].init.body);
        const asst = body.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
        return !!asst && asst.tool_calls[0].id === "call_1";
      })());
    pass("multi-turn executes the tool exactly once",
      toolExecutionLog.length === 1
      && toolExecutionLog[0].name === "search"
      && toolExecutionLog[0].args.q === "foo");
    pass("multi-turn returns final text after iteration",
      result.text === "Found 3 things.");
    pass("multi-turn iterations === 2", result.iterations === 2);
    pass("multi-turn accumulates tokens across iterations",
      result.inputTokens === 40 && result.outputTokens === 12);
    pass("multi-turn emits a tool_use SSE event",
      sent.some(e => e.type === "tool_use" && e.name === "search"));
    pass("multi-turn emits a tool_result SSE event",
      sent.some(e => e.type === "tool_result" && e.result === "matched 3 results"));
    pass("multi-turn records the toolUse with its result",
      result.toolUses.length === 1
      && result.toolUses[0].name === "search"
      && result.toolUses[0].result === "matched 3 results");
  }

  // ─── iteration cap: model keeps calling tools, we bail ─────────────
  {
    nextToolResult = "more data needed";
    // Each response is a tool_call so the model would loop forever.
    const toolCallResponse = [
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_X`, function: { name: "search", arguments: "{}" } }] } }] }),
      "data: [DONE]\n\n",
    ];
    const { result, sent } = await runScenario({
      responses: [toolCallResponse, toolCallResponse, toolCallResponse],
      maxIterations: 3,
    });
    pass("iteration cap honored (3 iterations)",
      result.iterations === 3);
    pass("iteration cap emits a warn log",
      sent.some(e => e.type === "log" && e.level === "warn" && /iteration cap/.test(e.message)));
    pass("iteration cap executes the tool 3x", toolExecutionLog.length === 3);
  }

  // ─── missing API key → errored result + error SSE event ───────────
  {
    nextApiKey = null;
    const { result, sent } = await runScenario({ responses: [] });
    pass("missing key produces errored=true", result.errored === true);
    pass("missing key error mentions Settings",
      /Settings/.test(result.errorMessage || ""));
    pass("missing key emits error SSE event",
      sent.some(e => e.type === "error"));
    pass("missing key does not call OpenAI", stub.callsMade.length === 0);
    nextApiKey = "sk-test-1234567890"; // restore for next tests
  }

  // ─── artifactIds picked up from toolCtx.artifactsCreated ──────────
  {
    nextToolResult = "ok";
    const artifacts = [{ id: "art_pre1", type: "document", title: "x" }];
    const { result } = await runScenario({
      responses: [[
        sse({ choices: [{ delta: { content: "done." } }] }),
        "data: [DONE]\n\n",
      ]],
      artifacts,
    });
    pass("artifactIds reflect toolCtx.artifactsCreated",
      result.artifactIds.length === 1 && result.artifactIds[0] === "art_pre1");
  }

  // Restore real fetch.
  (globalThis as any).fetch = origFetch;

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll openai-loop tests passed.");
})();
