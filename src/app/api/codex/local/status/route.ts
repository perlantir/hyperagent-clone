// P64 — Phase 2 runtime status.
//
// GET /api/codex/local/status → does this Node host support spawning
// codex app-server, and is the binary installed?
//
// The Settings UI calls this to decide whether to surface the
// "Codex Local" mode as available, gray it out (binary missing), or
// hide it entirely (Vercel / serverless).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getLocalRuntimeStatus, getCodexVersion, invalidateBinaryCache } from "@/lib/codex/local-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Allow ?refresh=1 to bust the binary detection cache so the UI's
  // "I just installed codex, retry" button works.
  const url = new URL(req.url);
  if (url.searchParams.get("refresh") === "1") invalidateBinaryCache();

  const status = getLocalRuntimeStatus();
  let version: string | null = null;
  if (status.supportsSpawn && status.codexBinary) {
    // Cheap (~ms). Cached internally by the binary detector.
    try { version = getCodexVersion(); } catch {}
  }

  // We deliberately don't return the absolute binary path — surface a
  // safe "installed at: $PATH" hint that doesn't leak the user's
  // filesystem layout to the browser tab.
  return NextResponse.json({
    supportsSpawn: status.supportsSpawn,
    reason: status.reason,
    runtime: status.runtime,
    codexInstalled: !!status.codexBinary,
    version,
  });
}
