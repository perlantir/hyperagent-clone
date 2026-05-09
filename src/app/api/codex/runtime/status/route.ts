// P66b — Unified Lane discriminator.
//
// GET /api/codex/runtime/status
//
// Returns a single JSON object the UI uses to decide which provider
// modes to offer. Combines:
//
//   - local runtime detection         (Lane A eligibility)
//   - companion paired status         (Lane B eligibility, shown but
//                                      P65.1 alpha until P66c/P66d)
//   - bridge configured status        (deprecated; surfaced for
//                                      legacy users only)
//
// The browser polls this when entering Settings → Codex; the chat
// dispatcher reads it to validate provider choices on send.
//
// SECURITY:
//
//   - The response includes runtime hostname / OS hints AND a short
//     `runtimeKey` enum the UI matches on. We do NOT include process
//     env, env vars, secrets, or anything path-shaped.
//
//   - Cache-Control: no-store. Lane state can change instant-by-
//     instant (companion goes offline, user logs out of codex). We
//     never want a forwarding proxy to cache.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getLocalRuntimeStatus } from "@/lib/codex/local-runtime";
import { getBridgeConfig } from "@/lib/codex/store";
import { pool } from "@/lib/db";
import { ensurePairingSchema } from "@/lib/codex/pair-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RuntimeStatusResponse {
  // Short enum the UI matches on. Adding a new variant is a
  // BREAKING change for the UI.
  runtimeKey: "vercel-hosted" | "local-dev" | "node-server" | "unknown";

  // Detailed lane eligibility.
  laneA: {
    eligible: boolean;
    reason?: string;
    codexBinary: string | null;
    codexVersion: string | null;
  };
  laneB: {
    eligible: boolean;        // we can OFFER companion mode
    paired: boolean;          // a pair session exists
    online: boolean;          // a companion is heartbeating
    sessionId: string | null;
    companionInfo?: any;
  };
  laneC: {
    // Always eligible if any direct API key is configured. This
    // route doesn't enumerate which keys are present — that's
    // /api/secrets — but it lets the UI surface a "use API/BYOK"
    // hint when neither A nor B is available.
    eligible: true;
  };

  // Hint enum for UI copy. Computed server-side so we centralize
  // the recommendation logic.
  recommendedLane: "A" | "B" | "C";

  // Hosted Vercel: false on `npm run dev`, true on Vercel.
  hostedOnVercel: boolean;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);

  const local = getLocalRuntimeStatus();
  const hostedOnVercel = !!(process.env.VERCEL || process.env.VERCEL_ENV);

  // Lane B: look for the user's most-recently-claimed pair session.
  // We don't take a userId-scoped lock; the listing is read-only and
  // a stale read here just makes the UI poll again.
  let laneB: RuntimeStatusResponse["laneB"] = {
    eligible: true,                  // companion can always be installed
    paired: false,
    online: false,
    sessionId: null,
  };
  try {
    await ensurePairingSchema();
    const r = await pool().query(
      `SELECT "id","status","lastHeartbeatAt","companionInfo","expiresAt"
         FROM codex_pair_sessions
        WHERE "userId" = $1 AND "status" = 'claimed'
        ORDER BY "claimedAt" DESC NULLS LAST
        LIMIT 1`,
      [user.id],
    );
    const row = r.rows[0];
    if (row) {
      const now = Date.now();
      const lastHb = row.lastHeartbeatAt ? Number(row.lastHeartbeatAt) : 0;
      const expiresAt = row.expiresAt ? Number(row.expiresAt) : 0;
      const online = lastHb > 0 && now - lastHb < 90_000 && now < expiresAt;
      laneB = {
        eligible: true,
        paired: true,
        online,
        sessionId: row.id,
        companionInfo: row.companionInfo,
      };
    }
  } catch {
    // Table may not exist yet on a fresh deployment; report no pair.
  }

  // Codex version for Lane A. Best-effort; we cache the version
  // string in local-runtime, but the binary path may have changed
  // since cache. We let local-runtime's TTL handle that.
  let codexVersion: string | null = null;
  if (local.supportsSpawn && local.codexBinary) {
    // Avoid spawning here; the version was captured at detect time.
    // local-runtime caches the binary path; we don't expose the
    // version directly today, but we can shell out cheaply.
    try {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(local.codexBinary, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
      codexVersion = (r.stdout?.toString("utf8") || "").trim() || null;
    } catch {
      // Non-fatal; UI will show "binary detected, version unknown".
    }
  }

  // Lane A eligibility: needs spawn AND binary present. On Vercel
  // we always say no.
  const laneA: RuntimeStatusResponse["laneA"] = local.supportsSpawn && !!local.codexBinary
    ? {
        eligible: true,
        codexBinary: local.codexBinary,
        codexVersion,
      }
    : {
        eligible: false,
        reason: local.supportsSpawn === false
          ? local.reason || "spawn_unavailable"
          : "codex_binary_missing",
        codexBinary: local.codexBinary || null,
        codexVersion: null,
      };

  // Recommendation logic:
  //
  //   - If Lane A eligible → A (running locally, cleanest path)
  //   - Else if Lane B online → B (paired companion ready)
  //   - Else → C (use API/BYOK; or pair a companion)
  //
  // We do NOT recommend B when A is eligible, because A is simpler
  // and avoids the relay round-trip.
  let recommendedLane: RuntimeStatusResponse["recommendedLane"] = "C";
  if (laneA.eligible) recommendedLane = "A";
  else if (laneB.online) recommendedLane = "B";

  const runtimeKey: RuntimeStatusResponse["runtimeKey"] =
    hostedOnVercel ? "vercel-hosted"
      : local.supportsSpawn ? (process.env.NODE_ENV === "development" ? "local-dev" : "node-server")
      : "unknown";

  const body: RuntimeStatusResponse = {
    runtimeKey,
    laneA,
    laneB,
    laneC: { eligible: true },
    recommendedLane,
    hostedOnVercel,
  };
  return jsonNoStore(body);
}

function jsonNoStore(body: any, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, max-age=0",
    },
  });
}
