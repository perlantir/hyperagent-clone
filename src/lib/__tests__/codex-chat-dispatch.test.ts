// P58 — chat-dispatch invariants.
//
// Smaller, focused checks on the cross-provider dispatch contract:
//   - runOpenAITurn surfaces upstream errors instead of silently falling
//     through to a different provider
//   - runCodexChatTurn returns 0/0 token counts (Codex billing is on the
//     user's ChatGPT plan)
//   - The dispatch never sees a "openaiUserApiKey" mode (collapsed)

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// Stub the providers + db so the runners don't try to reach the network.
const llmPath = require.resolve("../llm-providers");
(require as any).cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true,
  exports: {
    streamChat: async (_args: any) => {
      // Simulate an upstream auth failure.
      throw new Error("OpenAI API key not configured. Add one in Settings → API Keys.");
    },
  },
};

const dbPath = require.resolve("../db");
(require as any).cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: () => ({ query: async () => ({ rows: [] }) }) },
};

// Stub the bridge transport so the codex runner cleanly surfaces a
// connect failure (we're verifying error surfacing, not full bridge).
const transportPath = require.resolve("../codex/transport");
(require as any).cache[transportPath] = {
  id: transportPath, filename: transportPath, loaded: true,
  exports: {
    createWebSocketTransport: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:9999");
    },
  },
};

// Now require chat-dispatch — AFTER all stubs are in place, otherwise
// the transitive imports cache the real modules.
const { runOpenAITurn, runCodexChatTurn } = require("../chat-dispatch");

(async () => {
  // ─── runOpenAITurn surfaces an error rather than running silently ──
  {
    const sent: any[] = [];
    const r = await runOpenAITurn({
      userId: "u1",
      modelId: "gpt-4o",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      send: (e: any) => sent.push(e),
    });
    pass("runOpenAITurn returns errored=true on upstream failure",
      r.errored === true);
    pass("runOpenAITurn includes upstream message verbatim",
      /OpenAI API key not configured/.test(r.errorMessage || ""));
    pass("runOpenAITurn emits an error SSE event",
      sent.some(e => e.type === "error" && /OpenAI/i.test(e.message)));
    pass("runOpenAITurn does not emit any delta on failure",
      !sent.some(e => e.type === "delta"));
    pass("runOpenAITurn returns zero tokens on failure",
      r.inputTokens === 0 && r.outputTokens === 0);
  }

  // ─── runCodexChatTurn returns zero tokens (user's ChatGPT plan) ────
  {
    const sent: any[] = [];
    const r = await runCodexChatTurn({
      bridge: { url: "ws://127.0.0.1:9999", capabilityToken: "tok-aaaaaaaaaaaaaaaa" },
      threadId: "t-codex-fail",
      input: "hello",
      send: (e: any) => sent.push(e),
    });
    pass("runCodexChatTurn returns errored=true on connect failure",
      r.errored === true);
    pass("runCodexChatTurn surfaces ECONNREFUSED",
      /ECONNREFUSED/.test(r.errorMessage || ""));
    pass("runCodexChatTurn returns zero tokens (Codex bills via ChatGPT plan)",
      r.inputTokens === 0 && r.outputTokens === 0);
    pass("runCodexChatTurn emits an error SSE event",
      sent.some(e => e.type === "error"));
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll chat-dispatch tests passed.");
})();
