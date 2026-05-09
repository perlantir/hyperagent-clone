// P64 — local runtime detection invariants.
//
// Validates:
//   - Vercel env (VERCEL=1 OR VERCEL_ENV=production) → supportsSpawn=false
//     with reason="vercel-hosted"
//   - HYPERAGENT_DISABLE_LOCAL_CODEX=1 → supportsSpawn=false with
//     reason="explicitly-disabled"
//   - Otherwise → supportsSpawn=true and we attempt binary detection
//   - CODEX_BIN env override is honored
//   - Binary detector returns null when nothing matches
//   - invalidateBinaryCache() forces a re-scan

import { writeFileSync, mkdtempSync, chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// We import inline so we can reset module state between tests by
// nuking the require cache — runtime detection memoizes some lookups.
function freshImport() {
  const path = require.resolve("../codex/local-runtime");
  delete (require as any).cache[path];
  return require("../codex/local-runtime");
}

(async () => {
  // ─── Vercel env → blocked ─────────────────────────────────────────
  {
    const orig = { ...process.env };
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    delete process.env.HYPERAGENT_DISABLE_LOCAL_CODEX;
    const { getLocalRuntimeStatus } = freshImport();
    const s = getLocalRuntimeStatus();
    pass("VERCEL=1 → supportsSpawn=false", s.supportsSpawn === false);
    pass("VERCEL=1 → reason='vercel-hosted'", s.reason === "vercel-hosted");
    pass("VERCEL=1 → runtime='vercel'", s.runtime === "vercel");
    pass("VERCEL=1 → codexBinary=null", s.codexBinary === null);
    process.env = orig;
  }

  // ─── Explicit disable → blocked with the right reason ─────────────
  {
    const orig = { ...process.env };
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    process.env.HYPERAGENT_DISABLE_LOCAL_CODEX = "1";
    const { getLocalRuntimeStatus } = freshImport();
    const s = getLocalRuntimeStatus();
    pass("HYPERAGENT_DISABLE_LOCAL_CODEX=1 → supportsSpawn=false",
      s.supportsSpawn === false);
    pass("HYPERAGENT_DISABLE_LOCAL_CODEX=1 → reason='explicitly-disabled'",
      s.reason === "explicitly-disabled");
    process.env = orig;
  }

  // ─── Default node-server → spawn supported ────────────────────────
  {
    const orig = { ...process.env };
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.HYPERAGENT_DISABLE_LOCAL_CODEX;
    const { getLocalRuntimeStatus } = freshImport();
    const s = getLocalRuntimeStatus();
    pass("plain node → supportsSpawn=true", s.supportsSpawn === true);
    pass("plain node → runtime='node-server'", s.runtime === "node-server");
    process.env = orig;
  }

  // ─── CODEX_BIN env override is honored ───────────────────────────
  {
    const orig = { ...process.env };
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    // Make a fake "codex" file so detectCodexBinary finds it.
    const dir = mkdtempSync(join(tmpdir(), "codex-test-"));
    const fakeBin = join(dir, "codex-fake");
    writeFileSync(fakeBin, "#!/bin/sh\necho codex 0.0.0\n");
    chmodSync(fakeBin, 0o755);
    process.env.CODEX_BIN = fakeBin;

    const { getLocalRuntimeStatus, detectCodexBinary, invalidateBinaryCache } = freshImport();
    invalidateBinaryCache();
    const detected = detectCodexBinary();
    pass("CODEX_BIN override returns the configured path", detected === fakeBin);

    const s = getLocalRuntimeStatus();
    pass("getLocalRuntimeStatus surfaces the override binary",
      s.codexBinary === fakeBin);

    // Cache invalidation: nuke the file, invalidate, re-detect.
    try { unlinkSync(fakeBin); } catch {}
    delete process.env.CODEX_BIN;
    invalidateBinaryCache();
    const re = detectCodexBinary();
    pass("invalidateBinaryCache forces a re-scan",
      re === null || (typeof re === "string" && re !== fakeBin));
    process.env = orig;
  }

  // ─── Binary detector returns null when nothing on PATH matches ────
  {
    const orig = { ...process.env };
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.CODEX_BIN;
    process.env.PATH = "/this/path/does/not/exist";
    const { detectCodexBinary, invalidateBinaryCache } = freshImport();
    invalidateBinaryCache();
    const r = detectCodexBinary();
    pass("missing PATH entries → detectCodexBinary returns null", r === null);
    process.env = orig;
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll local-runtime tests passed.");
})();
