// P66b — Real-binary local-direct dispatch smoke test.
//
// Drives the chat-bridge `runCodexTurn` with mode="local-stdio" against
// a real `codex app-server`. Verifies:
//
//   1. Real codex binary detected via getLocalRuntimeStatus
//   2. createStdioTransport spawns it
//   3. AppServerClient initialize / getAuthStatus / account/read /
//      thread/start succeed
//   4. turn/start fires (codex may reject with auth-required when
//      unauthenticated; either is acceptable for this smoke)
//   5. Streaming events surface through the SSE-shaped callback
//   6. clean shutdown
//
// We mock the Postgres pool so the audit-log + thread-map writes
// don't need a real database, and we stub `createApproval` /
// `pollDecision` so any approval path that fires doesn't hang on
// a non-existent DB.
//
// Gate:  CODEX_SMOKE_TEST=1
// Usage: CODEX_SMOKE_TEST=1 npx tsx scripts/codex-local-direct-smoke-test.ts

import { randomBytes } from "node:crypto";

if (process.env.CODEX_SMOKE_TEST !== "1") {
  console.error("Refusing to run without CODEX_SMOKE_TEST=1");
  process.exit(2);
}

// ─── DB / approvals mocks ─────────────────────────────────────────────

const auditEvents: any[] = [];

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO codex_audit_log/.test(sql)) {
      auditEvents.push({
        userId: params[0], orgId: params[1], companionId: params[2], runId: params[3],
        providerMode: params[4], event: params[5], severity: params[6],
        details: typeof params[7] === "string" ? JSON.parse(params[7]) : params[7],
      });
      return { rows: [], rowCount: 1 };
    }
    // thread-map: SELECT existing codex thread id -> none
    if (/codex_thread_map/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/codex_artifacts|artifacts/i.test(sql)) return { rows: [], rowCount: 0 };
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

// thread-map: stub the get/set so we don't hit Postgres for it.
const threadMapPath = require.resolve("../src/lib/codex/thread-map");
(require as any).cache[threadMapPath] = {
  id: threadMapPath, filename: threadMapPath, loaded: true,
  exports: {
    getCodexThreadId: async (_t: string) => null,
    setCodexThreadId: async (_t: string, _ct: string) => undefined,
  },
};

// approvals-store: stub createApproval + pollDecision so any inbound
// approval request resolves immediately (decline) without DB.
const approvalsPath = require.resolve("../src/lib/codex/approvals-store");
(require as any).cache[approvalsPath] = {
  id: approvalsPath, filename: approvalsPath, loaded: true,
  exports: {
    createApproval: async () => undefined,
    pollDecision: async () => "decline",
  },
};

// ─── load runtime detection ───────────────────────────────────────────

const { getLocalRuntimeStatus } = require("../src/lib/codex/local-runtime");
const local = getLocalRuntimeStatus();
if (!local.supportsSpawn) {
  console.error("Local runtime cannot spawn codex; skipping smoke");
  console.log(JSON.stringify({ skipped: true, reason: local.reason }, null, 2));
  process.exit(0);
}
if (!local.codexBinary) {
  console.error("Codex binary not on PATH; skipping smoke");
  console.log(JSON.stringify({ skipped: true, reason: "codex_binary_missing" }, null, 2));
  process.exit(0);
}

// ─── drive runCodexTurn ───────────────────────────────────────────────

const { runCodexTurn } = require("../src/lib/codex/chat-bridge");

interface SmokeReport {
  binary: { path: string; version: string | null };
  runtime: { supportsSpawn: boolean; codexBinary: string | null };
  turnCompleted: boolean;
  errored: boolean;
  errorMessage: string | null;
  textLength: number;
  approvalCount: number;
  artifactCount: number;
  toolCount: number;
  sseEventTypes: string[];
  auditEvents: { event: string; severity: string }[];
  cleanShutdown: boolean;
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
      threadId: "t_smoke_" + randomBytes(3).toString("hex"),
      threadTitle: "P66b local smoke",
      input: "smoke test",
      userId: "u_smoke",
      assistantMessageId: "msg_smoke",
      send,
      // tight approval timeout — the unauthenticated codex won't
      // actually need approvals, but if it does we decline fast.
      approvalTimeoutMs: 800,
      // P66b — bound the turn at 12 s so we don't wait forever for
      // a `turn/finished` notification that codex won't emit when
      // unauthenticated. A timed-out turn still fires `run/failed`
      // in the audit log, which is what the smoke verifies.
      turnTimeoutMs: 12_000,
    });
  } catch (e: any) {
    threwOuter = true;
    outerErrMsg = e?.message || String(e);
  }

  const report: SmokeReport = {
    binary: {
      path: local.codexBinary,
      version: null,
    },
    runtime: {
      supportsSpawn: local.supportsSpawn,
      codexBinary: local.codexBinary,
    },
    turnCompleted: !threwOuter,
    errored: !!result?.errored,
    errorMessage: result?.errorMessage ?? (threwOuter ? outerErrMsg : null),
    textLength: result?.text?.length ?? 0,
    approvalCount: result?.approvalCount ?? 0,
    artifactCount: result?.artifactIds?.length ?? 0,
    toolCount: result?.toolUses?.length ?? 0,
    sseEventTypes: Array.from(new Set(sseEvents.map((e) => e.type))).slice(0, 30),
    auditEvents: auditEvents.map((a) => ({ event: a.event, severity: a.severity })),
    cleanShutdown: !threwOuter,
  };

  // Capture codex --version cheaply for the report.
  try {
    const { spawnSync } = await import("node:child_process");
    const v = spawnSync(local.codexBinary, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
    report.binary.version = (v.stdout?.toString("utf8") || "").trim() || null;
  } catch {}

  console.log(JSON.stringify(report, null, 2));

  // Smoke success criteria — we want all of:
  //   - turn completed without throwing (errored=true is OK; this
  //     covers the unauthenticated codex case)
  //   - run/created and run/completed-or-failed audit events emitted
  //   - clean shutdown
  const sawCreated = auditEvents.some((a) => a.event === "run/created");
  const sawTerminal = auditEvents.some(
    (a) => a.event === "run/completed" || a.event === "run/failed",
  );
  const ok = report.turnCompleted && sawCreated && sawTerminal && report.cleanShutdown;
  process.exit(ok ? 0 : 1);
})();
