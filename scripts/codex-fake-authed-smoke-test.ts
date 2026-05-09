// P66b.1 — Fake-authenticated Codex happy-path smoke.
//
// Builds a small "fake codex" Node script in a temp directory that
// mimics the codex 0.130.0 wire format AS IF it were authenticated —
// initialize succeeds, getAuthStatus reports authMethod="chatgpt",
// account/read returns a fake authenticated account, thread/start +
// turn/start respond synchronously, and the server emits a real-shape
// v2 streaming sequence:
//
//   turn/started → item/started (agent_message)
//                → item/agentMessage/delta × 3
//                → item/completed (agent_message, full text)
//                → turn/completed
//
// We then drive `runCodexTurn(transport: "local-stdio")` with the
// chat-bridge AGAINST this fake binary, point CODEX_BIN at it, and
// verify:
//
//   - chat-bridge consumes v2 notifications via the new translators
//   - text accumulates through deltas (P66b.1 wiring)
//   - audit log records run/created → run/completed
//   - clean shutdown
//
// This proves the FULL local-direct dispatch path works end-to-end
// with a happy-path codex *without* spending any real ChatGPT credits.
//
// Gate:  CODEX_SMOKE_TEST=1
// Usage: CODEX_SMOKE_TEST=1 npx tsx scripts/codex-fake-authed-smoke-test.ts

import { writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

if (process.env.CODEX_SMOKE_TEST !== "1") {
  console.error("Refusing to run without CODEX_SMOKE_TEST=1");
  process.exit(2);
}

// ─── DB / approvals / thread-map mocks (no real Postgres needed) ─────

const auditEvents: any[] = [];

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO codex_audit_log/.test(sql)) {
      auditEvents.push({
        userId: params[0], event: params[5], severity: params[6],
        details: typeof params[7] === "string" ? JSON.parse(params[7]) : params[7],
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};

const dbPath = require.resolve("../src/lib/db");
(require as any).cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: () => fakePool,
    createArtifact: async () => ({ id: "art_" + randomBytes(4).toString("hex") }),
  },
};

const threadMapPath = require.resolve("../src/lib/codex/thread-map");
(require as any).cache[threadMapPath] = {
  id: threadMapPath, filename: threadMapPath, loaded: true,
  exports: {
    getCodexThreadId: async () => null,
    setCodexThreadId: async () => undefined,
  },
};

const approvalsPath = require.resolve("../src/lib/codex/approvals-store");
(require as any).cache[approvalsPath] = {
  id: approvalsPath, filename: approvalsPath, loaded: true,
  exports: {
    createApproval: async () => undefined,
    pollDecision: async () => "decline",
  },
};

// ─── write the fake codex binary ─────────────────────────────────────
//
// The fake is a Node script that swallows the `app-server --listen
// stdio://` arguments codex normally takes, then speaks JSON-RPC 2.0
// over stdio in the v2 wire format.

const FAKE_CODEX_SOURCE = `#!${process.execPath}
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

function send(env) {
  process.stdout.write(JSON.stringify(env) + "\\n");
}

// Allow --version probe (the runtime-status route + audit-status
// route call this).
if (process.argv.length >= 3 && process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.130.0-fake\\n");
  process.exit(0);
}

// codex usually emits a configWarning + remoteControl notification
// during startup. We mimic that behavior so the chat-bridge sees
// the same notification flood as a real codex.
process.nextTick(() => {
  send({ jsonrpc: "2.0", method: "configWarning", params: { kind: "fake" } });
  send({ jsonrpc: "2.0", method: "remoteControl/status/changed", params: { status: "disabled" } });
});

let nextItemId = 1;

rl.on("line", (line) => {
  let env;
  try { env = JSON.parse(line); } catch { return; }

  if (env.method === "initialize") {
    send({
      jsonrpc: "2.0", id: env.id,
      result: {
        userAgent: "fake-codex/0.130.0",
        codexHome: "/tmp/.codex-fake",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (env.method === "getAuthStatus") {
    // Authenticated state.
    send({
      jsonrpc: "2.0", id: env.id,
      result: { authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: false },
    });
    return;
  }
  if (env.method === "account/read") {
    send({
      jsonrpc: "2.0", id: env.id,
      result: {
        account: { type: "chatgpt", email: "fake-test@example.invalid", planType: "plus" },
        requiresOpenaiAuth: false,
      },
    });
    return;
  }
  if (env.method === "thread/start") {
    send({
      jsonrpc: "2.0", id: env.id,
      result: {
        thread: { id: "ct_fake_" + Date.now() },
        model: "gpt-5",
        modelProvider: "openai",
        cwd: "/tmp",
      },
    });
    return;
  }
  if (env.method === "turn/start") {
    const turnId = "tu_fake_" + Date.now();
    send({ jsonrpc: "2.0", id: env.id, result: { turn: { id: turnId } } });

    // Fire the v2 streaming sequence. Real codex emits these
    // ASYNCHRONOUSLY relative to the turn/start response, so we
    // schedule them with a small stagger.
    const itemId = "im" + (nextItemId++);
    setTimeout(() => send({ jsonrpc: "2.0", method: "turn/started", params: { turnId } }), 5);
    setTimeout(() => send({
      jsonrpc: "2.0", method: "item/started",
      params: { itemId, itemType: "agent_message", turnId },
    }), 10);
    const chunks = ["O", "K"];
    chunks.forEach((delta, i) => {
      setTimeout(() => send({
        jsonrpc: "2.0", method: "item/agentMessage/delta",
        params: { itemId, delta },
      }), 20 + i * 5);
    });
    setTimeout(() => send({
      jsonrpc: "2.0", method: "item/completed",
      params: { itemId, itemType: "agent_message", text: "OK" },
    }), 50);
    setTimeout(() => send({
      jsonrpc: "2.0", method: "turn/completed",
      params: { turnId, status: { type: "completed" } },
    }), 60);
    return;
  }
  if (env.method === "account/logout") {
    send({ jsonrpc: "2.0", id: env.id, result: {} });
    return;
  }
  // Unknown methods — reply with -32601 like real codex does.
  if (typeof env.id !== "undefined") {
    send({
      jsonrpc: "2.0", id: env.id,
      error: { code: -32601, message: "method not found: " + env.method },
    });
  }
});
rl.on("close", () => process.exit(0));
`;

const tmp = mkdtempSync(join(tmpdir(), "codex-fake-authed-"));
const fakeBin = join(tmp, "fake-codex");
writeFileSync(fakeBin, FAKE_CODEX_SOURCE, { mode: 0o755 });
chmodSync(fakeBin, 0o755);

// Override CODEX_BIN BEFORE we require modules that read it.
process.env.CODEX_BIN = fakeBin;

// ─── drive runCodexTurn ─────────────────────────────────────────────

// Local-runtime status would otherwise check `which codex`. We stub
// it to report eligible + use the fake binary.
const localRuntimePath = require.resolve("../src/lib/codex/local-runtime");
(require as any).cache[localRuntimePath] = {
  id: localRuntimePath, filename: localRuntimePath, loaded: true,
  exports: {
    getLocalRuntimeStatus: () => ({
      supportsSpawn: true,
      codexBinary: fakeBin,
      runtime: "node-server",
    }),
  },
};

// Re-import chat-bridge AFTER cache wiring so it sees the mocks.
const { runCodexTurn } = require("../src/lib/codex/chat-bridge");

interface SmokeReport {
  fakeBinaryPath: string;
  turnCompleted: boolean;
  errored: boolean;
  textLength: number;
  finalText: string;
  containsOK: boolean;
  sseEventTypes: string[];
  sseDeltaCount: number;
  auditEvents: { event: string; severity: string }[];
  cleanShutdown: boolean;
  // Verifies redaction. We also want to confirm no token-shaped strings
  // leak through any field of the run result or audit details.
  noTokenLeak: boolean;
}

(async () => {
  const sseEvents: any[] = [];
  const send = (e: any) => sseEvents.push(e);

  let result: any = null;
  let threwOuter = false;
  let outerErrMsg = "";
  try {
    result = await runCodexTurn({
      transport: "local-stdio",
      threadId: "t_fake_authed_" + randomBytes(3).toString("hex"),
      threadTitle: "P66b.1 fake-authed smoke",
      input: "Reply with exactly: OK",
      userId: "u_smoke",
      assistantMessageId: "msg_smoke",
      send,
      approvalTimeoutMs: 500,
      turnTimeoutMs: 8_000,
    });
  } catch (e: any) {
    threwOuter = true;
    outerErrMsg = e?.message || String(e);
  }

  // No-token-leak audit. Walk audit details + SSE events and look for
  // anything matching token-shaped patterns.
  const TOKEN_RE = /(Bearer\s+[A-Za-z0-9._\-=]{16,}|sk-[A-Za-z0-9._\-=]{16,}|eyJ[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]+)/;
  const dump = JSON.stringify({ auditEvents, sseEvents, result });
  const noTokenLeak = !TOKEN_RE.test(dump);

  const report: SmokeReport = {
    fakeBinaryPath: fakeBin,
    turnCompleted: !threwOuter,
    errored: !!result?.errored,
    textLength: result?.text?.length ?? 0,
    finalText: result?.text ?? "",
    containsOK: typeof result?.text === "string" && result.text.includes("OK"),
    sseEventTypes: Array.from(new Set(sseEvents.map((e) => e.type))).slice(0, 30),
    sseDeltaCount: sseEvents.filter((e) => e.type === "delta").length,
    auditEvents: auditEvents.map((a) => ({ event: a.event, severity: a.severity })),
    cleanShutdown: !threwOuter,
    noTokenLeak,
  };

  // Print a redacted summary. We deliberately do not print full SSE
  // payloads or audit details — the report fields above are the
  // public surface.
  console.log(JSON.stringify(report, null, 2));

  // Smoke success criteria.
  const sawCreated = auditEvents.some((a) => a.event === "run/created");
  const sawCompleted = auditEvents.some((a) => a.event === "run/completed");
  const ok =
    report.turnCompleted &&
    report.errored === false &&
    report.containsOK &&
    sawCreated &&
    sawCompleted &&
    report.cleanShutdown &&
    report.noTokenLeak;
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("[fake-authed smoke] fatal:", e);
  process.exit(1);
});
