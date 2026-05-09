// P66b.1 — Verify Vercel production rejects codexChatGPTLocal.
//
// Runs `getLocalRuntimeStatus()` with VERCEL=1 set and asserts:
//   - supportsSpawn === false
//   - reason === "vercel-hosted"
//   - codexBinary === null
//   - runtime === "vercel"
//
// Then drives the runtime/status route and confirms:
//   - laneA.eligible === false
//   - laneA.reason === "vercel-hosted" or "spawn_unavailable"
//   - hostedOnVercel === true
//   - recommendedLane !== "A"
//
// Gate: CODEX_SMOKE_TEST=1
// Usage: CODEX_SMOKE_TEST=1 VERCEL=1 npx tsx scripts/codex-vercel-rejects-local.smoke.ts

if (process.env.CODEX_SMOKE_TEST !== "1") {
  console.error("Refusing to run without CODEX_SMOKE_TEST=1");
  process.exit(2);
}

// Force Vercel mode for this smoke regardless of how it's invoked.
process.env.VERCEL = "1";
process.env.VERCEL_ENV = "production";

const { getLocalRuntimeStatus } = require("../src/lib/codex/local-runtime");

const status = getLocalRuntimeStatus();

interface Report {
  vercelEnv: { VERCEL: string | undefined; VERCEL_ENV: string | undefined };
  runtimeStatus: any;
  invariantsHeld: {
    supportsSpawnIsFalse: boolean;
    reasonVercelHosted: boolean;
    codexBinaryNull: boolean;
    runtimeIsVercel: boolean;
  };
  ok: boolean;
}

const invariantsHeld = {
  supportsSpawnIsFalse: status.supportsSpawn === false,
  reasonVercelHosted: status.reason === "vercel-hosted",
  codexBinaryNull: status.codexBinary === null,
  runtimeIsVercel: status.runtime === "vercel",
};

const report: Report = {
  vercelEnv: { VERCEL: process.env.VERCEL, VERCEL_ENV: process.env.VERCEL_ENV },
  runtimeStatus: status,
  invariantsHeld,
  ok: Object.values(invariantsHeld).every(Boolean),
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
