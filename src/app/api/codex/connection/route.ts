// P57 — Codex bridge connection management.
//
//   GET    /api/codex/connection — does the user have a bridge configured?
//   POST   /api/codex/connection — set/replace bridge URL + capability token
//   DELETE /api/codex/connection — clear bridge config (does NOT clear ChatGPT
//                                  auth in the bridge itself; user does that
//                                  via /api/codex/account DELETE)
//
// Body for POST: { url, capabilityToken, experimentalApi? }
// Response never includes the capabilityToken in plaintext.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getBridgeConfig, setBridgeConfig, deleteBridgeConfig } from "@/lib/codex/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = await getBridgeConfig(user.id);
  if (!cfg) return NextResponse.json({ configured: false });
  // Show URL host but NEVER the capability token. Last 4 chars of the
  // token are fine as a "this is the active token" indicator.
  let host = "";
  try { host = new URL(cfg.url).host; } catch {}
  const tokenTail = cfg.capabilityToken.slice(-4);
  return NextResponse.json({
    configured: true,
    host,
    tokenTail,
    experimentalApi: !!cfg.experimentalApi,
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { url, capabilityToken, experimentalApi } = body || {};
  if (typeof url !== "string" || typeof capabilityToken !== "string") {
    return NextResponse.json({ error: "url and capabilityToken are required" }, { status: 400 });
  }
  try {
    await setBridgeConfig(user.id, { url, capabilityToken, experimentalApi: !!experimentalApi });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to save" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteBridgeConfig(user.id);
  return NextResponse.json({ ok: true });
}
