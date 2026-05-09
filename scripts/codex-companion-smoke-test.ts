// P65 — Real-binary Codex Companion smoke test.
//
// Spawns the actual `codex app-server` binary inside a fake "companion"
// orchestration to confirm:
//
//   1. detectCodex finds the real binary
//   2. CodexProcess starts codex over stdio
//   3. initialize round-trips against real codex
//   4. getAuthStatus returns a sensible shape
//   5. account/read returns a sensible shape (even when unauthenticated)
//   6. thread/start succeeds (only if codex is signed in; otherwise we
//      record the auth-required error and continue)
//   7. clean shutdown
//
// Run with:
//
//   CODEX_SMOKE_TEST=1 npx tsx scripts/codex-companion-smoke-test.ts
//
// Output is a JSON report we paste into CODEX_REVIEW.md's P65 section.

import path from "node:path";

if (process.env.CODEX_SMOKE_TEST !== "1") {
  console.error("Refusing to run without CODEX_SMOKE_TEST=1");
  process.exit(2);
}

const COMPANION_DIR = path.resolve(__dirname, "..", "packages", "codex-companion");
const { CodexProcess, detectCodex } = require(path.join(COMPANION_DIR, "src", "codex-process.js"));

interface Report {
  binary: { found: boolean; version: string | null; error?: string };
  initialize: { ok: boolean; result?: any; error?: string };
  getAuthStatus: { ok: boolean; result?: any; error?: string };
  accountRead: { ok: boolean; result?: any; error?: string };
  threadStart: { ok: boolean; result?: any; error?: string };
  cleanShutdown: boolean;
  notificationsObserved: string[];
  stderrLines: number;
}

const report: Report = {
  binary: { found: false, version: null },
  initialize: { ok: false },
  getAuthStatus: { ok: false },
  accountRead: { ok: false },
  threadStart: { ok: false },
  cleanShutdown: false,
  notificationsObserved: [],
  stderrLines: 0,
};

(async () => {
  const detect = detectCodex(process.env.CODEX_BIN || "codex");
  report.binary.found = !!detect.found;
  report.binary.version = detect.version || null;
  if (!detect.found) {
    report.binary.error = detect.error;
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const codex = new CodexProcess({ binPath: process.env.CODEX_BIN || "codex" });
  codex.onNotification((env: any) => {
    if (typeof env?.method === "string" && !report.notificationsObserved.includes(env.method)) {
      report.notificationsObserved.push(env.method);
    }
  });
  codex.onStderr(() => { report.stderrLines++; });
  await codex.start();

  // ─── initialize ────────────────────────────────────────────────────
  try {
    const r = await codex.request("initialize", {
      clientInfo: { name: "hyperagent-codex-companion-smoketest", title: null, version: "0.0.0" },
      capabilities: { experimentalApi: false, optOutNotificationMethods: null },
    });
    report.initialize.ok = true;
    report.initialize.result = r;
  } catch (e: any) {
    report.initialize.error = String(e?.message || e);
  }

  // ─── getAuthStatus ─────────────────────────────────────────────────
  try {
    const r = await codex.request("getAuthStatus", { includeToken: false, refreshToken: false });
    report.getAuthStatus.ok = true;
    report.getAuthStatus.result = r;
  } catch (e: any) {
    report.getAuthStatus.error = String(e?.message || e);
  }

  // ─── account/read ──────────────────────────────────────────────────
  try {
    const r = await codex.request("account/read", { refreshToken: false });
    report.accountRead.ok = true;
    report.accountRead.result = r;
  } catch (e: any) {
    report.accountRead.error = String(e?.message || e);
  }

  // ─── thread/start ──────────────────────────────────────────────────
  // Will fail with auth-required when codex is signed out; that's
  // documented as the expected output in the unauthenticated lane.
  try {
    const r = await codex.request("thread/start", {});
    report.threadStart.ok = true;
    report.threadStart.result = { thread: r?.thread, model: r?.model, modelProvider: r?.modelProvider };
  } catch (e: any) {
    report.threadStart.error = String(e?.message || e);
  }

  // ─── shutdown ──────────────────────────────────────────────────────
  await codex.stop();
  report.cleanShutdown = true;

  // Allow notifications buffered in stderr to flush before reporting.
  await new Promise((r) => setTimeout(r, 100));
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error("[smoke] fatal:", e);
  console.log(JSON.stringify({ ...report, fatal: String(e) }, null, 2));
  process.exit(1);
});
