// P66b — runtime/status Lane discriminator tests.
//
// Hits the GET handler directly (no HTTP server). Exercises:
//   - Lane A eligibility flips on supportsSpawn + codex binary
//   - Lane A blocked on Vercel
//   - Lane B paired/online derives from pair-store row state
//   - recommendedLane resolves correctly (A > B > C)
//   - cache headers no-store
//
// Mocks `getLocalRuntimeStatus`, `getCurrentUser`, and the pair-store
// query so we can test logic without spawning real codex or Postgres.

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// ─── Mock setup ────────────────────────────────────────────────────

const localRuntime = { value: { supportsSpawn: true, codexBinary: "/usr/bin/codex", runtime: "node-server" as const } };
const localRuntimePath = require.resolve("../codex/local-runtime");
(require as any).cache[localRuntimePath] = {
  id: localRuntimePath, filename: localRuntimePath, loaded: true,
  exports: { getLocalRuntimeStatus: () => localRuntime.value },
};

const authPath = require.resolve("../auth");
(require as any).cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { getCurrentUser: async () => ({ id: "u1" }) },
};

const pairStorePath = require.resolve("../codex/pair-store");
(require as any).cache[pairStorePath] = {
  id: pairStorePath, filename: pairStorePath, loaded: true,
  exports: { ensurePairingSchema: async () => undefined },
};

let pairRows: any[] = [];
const dbPath = require.resolve("../db");
(require as any).cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: () => ({
      query: async (_sql: string, _params: any[]) => ({ rows: pairRows, rowCount: pairRows.length }),
    }),
  },
};

// Stub the spawnSync that the route uses to get codex --version.
const childProcess = require("node:child_process") as any;
const realSpawnSync = childProcess.spawnSync;
let spawnSyncStub: ((bin: string, args: string[]) => { stdout: Buffer }) | null = null;
childProcess.spawnSync = (bin: string, args: string[], opts?: any) => {
  if (spawnSyncStub) return spawnSyncStub(bin, args);
  return realSpawnSync(bin, args, opts);
};

// Now require the route. We do this AFTER the cache stubs so its
// imports resolve to our mocks.
const routePath = require.resolve("../../app/api/codex/runtime/status/route");
delete (require as any).cache[routePath];
const { GET } = require(routePath);

async function callGet(): Promise<{ status: number; body: any; cacheControl: string | null }> {
  const res = await GET();
  const body = await res.json();
  return {
    status: res.status,
    body,
    cacheControl: res.headers.get("cache-control"),
  };
}

(async () => {
  // ─── runtime: local with codex binary → Lane A eligible ────────────
  {
    localRuntime.value = { supportsSpawn: true, codexBinary: "/usr/bin/codex", runtime: "node-server" as const };
    spawnSyncStub = () => ({ stdout: Buffer.from("codex-cli 0.130.0\n") });
    pairRows = [];
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = "development";
    const r = await callGet();
    pass("local+codex → 200", r.status === 200);
    pass("Lane A eligible", r.body.laneA?.eligible === true);
    pass("Lane A reports codexVersion", r.body.laneA?.codexVersion === "codex-cli 0.130.0");
    pass("Lane B not paired", r.body.laneB?.paired === false);
    pass("Lane C always eligible", r.body.laneC?.eligible === true);
    pass("recommendedLane = A when A is eligible", r.body.recommendedLane === "A");
    pass("runtimeKey = local-dev when NODE_ENV=development", r.body.runtimeKey === "local-dev");
    pass("hostedOnVercel = false outside Vercel", r.body.hostedOnVercel === false);
    pass("cache-control no-store",
      r.cacheControl?.includes("no-store") === true);
  }

  // ─── Vercel hosting → Lane A blocked ───────────────────────────────
  {
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    localRuntime.value = { supportsSpawn: false, codexBinary: null, runtime: "vercel" as const, reason: "vercel-hosted" };
    spawnSyncStub = () => ({ stdout: Buffer.from("") });
    pairRows = [];
    const r = await callGet();
    pass("Vercel: Lane A NOT eligible",
      r.body.laneA?.eligible === false);
    pass("Vercel: reason populated",
      r.body.laneA?.reason === "vercel-hosted" || r.body.laneA?.reason === "spawn_unavailable");
    pass("Vercel: runtimeKey = vercel-hosted",
      r.body.runtimeKey === "vercel-hosted");
    pass("Vercel: hostedOnVercel = true",
      r.body.hostedOnVercel === true);
    pass("Vercel: recommendedLane = C",
      r.body.recommendedLane === "C");
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
  }

  // ─── codex binary missing → Lane A blocked ─────────────────────────
  {
    localRuntime.value = { supportsSpawn: true, codexBinary: null, runtime: "node-server" as const };
    spawnSyncStub = () => ({ stdout: Buffer.from("") });
    pairRows = [];
    const r = await callGet();
    pass("no codex: Lane A NOT eligible",
      r.body.laneA?.eligible === false);
    pass("no codex: reason = codex_binary_missing",
      r.body.laneA?.reason === "codex_binary_missing");
  }

  // ─── Lane B online → recommendedLane = B (when A not eligible) ────
  {
    localRuntime.value = { supportsSpawn: false, codexBinary: null, runtime: "vercel" as const, reason: "vercel-hosted" };
    process.env.VERCEL = "1";
    pairRows = [{
      id: "ses_abc",
      status: "claimed",
      lastHeartbeatAt: Date.now() - 5_000,         // fresh heartbeat
      expiresAt: Date.now() + 24 * 3600_000,
      companionInfo: { packageVersion: "0.1.0" },
    }];
    const r = await callGet();
    pass("Lane B paired = true", r.body.laneB?.paired === true);
    pass("Lane B online = true (fresh heartbeat)", r.body.laneB?.online === true);
    pass("Lane B sessionId returned", r.body.laneB?.sessionId === "ses_abc");
    pass("Lane B companionInfo passed through",
      r.body.laneB?.companionInfo?.packageVersion === "0.1.0");
    pass("recommendedLane = B when only B is online",
      r.body.recommendedLane === "B");
    delete process.env.VERCEL;
  }

  // ─── Lane B paired but stale heartbeat → online = false ───────────
  {
    localRuntime.value = { supportsSpawn: false, codexBinary: null, runtime: "vercel" as const, reason: "vercel-hosted" };
    process.env.VERCEL = "1";
    pairRows = [{
      id: "ses_old",
      status: "claimed",
      lastHeartbeatAt: Date.now() - 5 * 60_000,    // 5 min stale
      expiresAt: Date.now() + 24 * 3600_000,
      companionInfo: null,
    }];
    const r = await callGet();
    pass("Lane B online = false on stale heartbeat",
      r.body.laneB?.online === false);
    pass("Lane B paired still true",
      r.body.laneB?.paired === true);
    pass("recommendedLane falls through to C when B not online",
      r.body.recommendedLane === "C");
    delete process.env.VERCEL;
  }

  // ─── unauthenticated → 401 ────────────────────────────────────────
  {
    (require as any).cache[authPath].exports.getCurrentUser = async () => null;
    const r = await callGet();
    pass("no user → 401", r.status === 401);
    (require as any).cache[authPath].exports.getCurrentUser = async () => ({ id: "u1" });
  }

  if (failed > 0) {
    console.error(`\n${failed} runtime-status test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-runtime-status tests passed");
})();
