// P66b.1 — Local authenticated Codex smoke (USER RUNS ON OWN MACHINE).
//
// This is the human-in-the-loop verification step for P66b.1. It
// spawns the user's REAL codex binary, drives a real authenticated
// turn against the user's own ChatGPT/Codex subscription, and
// verifies the chat-bridge's v2 notification translators produce a
// completed assistant message.
//
// We deliberately keep the prompt minimal ("Reply with exactly: OK")
// to keep ChatGPT credit consumption negligible.
//
// Usage:
//
//   1. Sign codex into ChatGPT first (one-time):
//        codex login --device-auth
//
//   2. Confirm:
//        codex login status
//        # → Logged in as <email> · <plan>
//
//   3. Run this smoke (gated):
//        CODEX_AUTHENTICATED_SMOKE_TEST=1 npx tsx scripts/codex-local-authenticated-smoke-test.ts
//
// The script prints a REDACTED summary only. It never logs the
// JWT, refresh token, full email, or any auth header.
//
// SAFETY:
//
//   - Gated by CODEX_AUTHENTICATED_SMOKE_TEST=1. Will refuse to run
//     otherwise.
//   - Hard-blocks running on Vercel (`process.env.VERCEL`).
//   - Bounds the turn at 30 s so a stuck codex doesn't hang.
//   - Mocks Postgres + thread-map + approvals so no DB writes happen.
//   - Never persists ChatGPT/Codex tokens anywhere — those stay in
//     codex's own ~/.codex/ directory.
//
// Exit codes:
//   0  — smoke passed, codex returned an "OK" answer
//   1  — smoke failed (see report fields)
//   2  — refused (gate / not authenticated / Vercel)

import { randomBytes } from "node:crypto";

if (process.env.CODEX_AUTHENTICATED_SMOKE_TEST !== "1") {
  console.error(
    "Refusing to run without CODEX_AUTHENTICATED_SMOKE_TEST=1. " +
    "This script consumes real ChatGPT subscription usage."
  );
  process.exit(2);
}

if (process.env.VERCEL || process.env.VERCEL_ENV) {
  console.error("Refusing to run on Vercel. Run on your local machine.");
  process.exit(2);
}

// ─── In-memory mocks for the dependencies the script doesn't need ────

const auditEvents: any[] = [];

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO codex_audit_log/.test(sql)) {
      auditEvents.push({
        event: params[5],
        severity: params[6],
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

// ─── Pre-flight checks ────────────────────────────────────────────────

const { getLocalRuntimeStatus } = require("../src/lib/codex/local-runtime");
const local = getLocalRuntimeStatus();

if (!local.supportsSpawn) {
  console.error("Local runtime cannot spawn codex (reason: " + (local.reason || "unknown") + ")");
  process.exit(2);
}
if (!local.codexBinary) {
  console.error("Codex binary not on PATH. Install: https://github.com/openai/codex");
  process.exit(2);
}

// Pre-flight #1: verify codex is actually authenticated using a brief
// app-server probe. We spawn codex once just to call getAuthStatus,
// then close it before driving the real turn.
async function preflightAuthCheck(): Promise<{ authMethod: string | null; planType?: string | null; emailHash?: string | null }> {
  const { createStdioTransport } = require("../src/lib/codex/transport");
  const { AppServerClient } = require("../src/lib/codex/app-server");
  const transport = await createStdioTransport({ command: local.codexBinary });
  const client = new AppServerClient({ transport });
  try {
    await client.connect();
    const auth = await (client as any).getAuthStatus({ includeToken: false, refreshToken: false });
    if (!auth || auth.authMethod === null || auth.requiresOpenaiAuth === true) {
      throw new Error("not_authenticated");
    }
    let planType: string | null = null;
    let emailHash: string | null = null;
    try {
      const acct = await client.accountRead({ refreshToken: false });
      planType = acct?.account?.planType ?? null;
      // Hash the email so the redacted summary doesn't reveal identity.
      const email: string | undefined = acct?.account?.email;
      if (email) {
        const { createHash } = await import("node:crypto");
        emailHash = "sha256:" + createHash("sha256").update(email).digest("hex").slice(0, 12);
      }
    } catch {
      // optional; not required for the smoke
    }
    return { authMethod: auth.authMethod, planType, emailHash };
  } finally {
    try { await client.close(); } catch {}
    try { await transport.close?.(); } catch {}
  }
}

// ─── Drive the smoke ──────────────────────────────────────────────────

const { runCodexTurn } = require("../src/lib/codex/chat-bridge");

interface AuthedSmokeReport {
  binary: { path: string; version: string | null };
  preflight: {
    authMethod: string | null;
    planType: string | null;
    emailHash: string | null;
  };
  turn: {
    completed: boolean;
    errored: boolean;
    textLength: number;
    finalText: string;       // intentionally included — caller asked
    containsOK: boolean;
    deltaCount: number;
    sseEventTypes: string[];
  };
  audit: { event: string; severity: string }[];
  cleanShutdown: boolean;
  redactionCheck: { tokenLeakDetected: boolean };
}

(async () => {
  // Capture codex --version for the report.
  let version: string | null = null;
  try {
    const { spawnSync } = await import("node:child_process");
    const v = spawnSync(local.codexBinary, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
    version = (v.stdout?.toString("utf8") || "").trim() || null;
  } catch {}

  // Pre-flight auth check. Refuse if not authenticated.
  let preflight: { authMethod: string | null; planType?: string | null; emailHash?: string | null };
  try {
    preflight = await preflightAuthCheck();
  } catch (e: any) {
    const msg = e?.message === "not_authenticated"
      ? "Codex reports requiresOpenaiAuth=true. Run `codex login --device-auth` first."
      : `Auth pre-flight failed: ${e?.message || e}`;
    console.error(msg);
    process.exit(2);
  }

  const sseEvents: any[] = [];
  const send = (e: any) => sseEvents.push(e);

  let result: any = null;
  let threwOuter = false;
  try {
    result = await runCodexTurn({
      transport: "local-stdio",
      threadId: "t_authed_" + randomBytes(3).toString("hex"),
      threadTitle: "P66b.1 authenticated smoke",
      input: "Reply with exactly: OK",
      userId: "u_authed_smoke",
      assistantMessageId: "msg_authed",
      send,
      approvalTimeoutMs: 1500,
      turnTimeoutMs: 30_000,
    });
  } catch {
    threwOuter = true;
  }

  // Token-leak audit. Walk all SSE events + the result's text +
  // audit details and look for token-shaped strings.
  const TOKEN_RE = /(Bearer\s+[A-Za-z0-9._\-=]{16,}|sk-[A-Za-z0-9._\-=]{16,}|eyJ[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]+)/;
  const corpus = JSON.stringify({ sseEvents, result, auditEvents });
  const tokenLeakDetected = TOKEN_RE.test(corpus);

  const report: AuthedSmokeReport = {
    binary: { path: local.codexBinary, version },
    preflight: {
      authMethod: preflight.authMethod ?? null,
      planType: preflight.planType ?? null,
      emailHash: preflight.emailHash ?? null,
    },
    turn: {
      completed: !threwOuter,
      errored: !!result?.errored,
      textLength: result?.text?.length ?? 0,
      finalText: result?.text ?? "",
      containsOK: typeof result?.text === "string" && result.text.includes("OK"),
      deltaCount: sseEvents.filter((e) => e.type === "delta").length,
      sseEventTypes: Array.from(new Set(sseEvents.map((e) => e.type))),
    },
    audit: auditEvents.map((a) => ({ event: a.event, severity: a.severity })),
    cleanShutdown: !threwOuter,
    redactionCheck: { tokenLeakDetected },
  };

  console.log(JSON.stringify(report, null, 2));

  const sawCreated = auditEvents.some((a) => a.event === "run/created");
  const sawCompleted = auditEvents.some((a) => a.event === "run/completed");
  const ok =
    report.turn.completed &&
    report.turn.errored === false &&
    report.turn.containsOK &&
    sawCreated &&
    sawCompleted &&
    report.cleanShutdown &&
    !report.redactionCheck.tokenLeakDetected;
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("[authed smoke] fatal:", e);
  process.exit(1);
});
