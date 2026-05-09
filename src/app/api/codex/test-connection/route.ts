// P64 — Phase 1 connection test.
//
// POST /api/codex/test-connection
//
// Opens a one-shot connection to the user's configured Codex bridge
// (Phase 1) and runs initialize + account/read. Returns the auth state
// the bridge reports plus a latency measurement. Used by the "Test
// connection" button in Settings → Chat provider → Codex Bridge.
//
// Never logs the URL or token. Errors are mapped to user-actionable
// messages ("bridge unreachable", "auth rejected", "bridge protocol
// version mismatch"). Underlying error strings pass through redact()
// before going anywhere persistent.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getBridgeConfig } from "@/lib/codex/store";
import { AppServerClient } from "@/lib/codex/app-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = await getBridgeConfig(user.id);
  if (!cfg) return NextResponse.json({ error: "No Codex bridge configured" }, { status: 400 });

  const client = new AppServerClient({
    url: cfg.url,
    capabilityToken: cfg.capabilityToken,
    capabilities: { experimentalApi: cfg.experimentalApi },
  });
  const t0 = Date.now();
  try {
    await client.connect();
    const acct = await client.accountRead();
    const elapsedMs = Date.now() - t0;
    // Strip accountId so we don't leak it back over the wire.
    const { accountId: _drop, ...safe } = (acct as any) || {};
    return NextResponse.json({
      ok: true,
      elapsedMs,
      account: safe,
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      // The AppServerClient already redacts the inner error message.
      error: e?.message || "Connection test failed",
      elapsedMs: Date.now() - t0,
    }, { status: 502 });
  } finally {
    try { await client.close(); } catch {}
  }
}
