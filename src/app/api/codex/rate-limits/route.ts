// P57 — Codex rate-limits passthrough.
//
//   GET /api/codex/rate-limits
//
// Forwards account/rateLimits/read so the Settings UI can show the user's
// current ChatGPT plan window. Read-only; no secrets in the response.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getBridgeConfig } from "@/lib/codex/store";
import { AppServerClient } from "@/lib/codex/app-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = await getBridgeConfig(user.id);
  if (!cfg) return NextResponse.json({ error: "No Codex bridge configured." }, { status: 400 });

  const client = new AppServerClient({
    url: cfg.url,
    capabilityToken: cfg.capabilityToken,
    capabilities: { experimentalApi: cfg.experimentalApi },
  });
  try {
    await client.connect();
    const r = await client.accountRateLimitsRead();
    return NextResponse.json({ rateLimits: r });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "rate-limits read failed" }, { status: 502 });
  } finally {
    await client.close().catch(() => {});
  }
}
