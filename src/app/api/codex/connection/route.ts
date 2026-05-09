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
  let host = "";
  // P64.1 — for browser-direct bridges, return the FULL URL so the
  // browser can connect. The URL itself contains no secret (the token
  // is separate), but it does carry the user's chosen port. We deliberately
  // mask the token tail to the last 4 chars and never include the
  // raw token in any response.
  let url = "";
  try {
    const u = new URL(cfg.url);
    host = u.host;
    url = cfg.url;
  } catch {}
  const tokenTail = cfg.capabilityToken.slice(-4);
  return NextResponse.json({
    configured: true,
    host,
    url, // browser uses this for browser-direct connections
    tokenTail,
    experimentalApi: !!cfg.experimentalApi,
    connectionLocation: cfg.connectionLocation || "browser",
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { url, capabilityToken, experimentalApi, connectionLocation } = body || {};
  if (typeof url !== "string" || typeof capabilityToken !== "string") {
    return NextResponse.json({ error: "url and capabilityToken are required" }, { status: 400 });
  }
  // P64.1 — connectionLocation is required from the UI. Default to
  // "browser" only when not specified (back-compat with older clients).
  const loc = connectionLocation === "tunnel" || connectionLocation === "local-server"
    ? connectionLocation
    : "browser";
  try {
    await setBridgeConfig(user.id, {
      url,
      capabilityToken,
      experimentalApi: !!experimentalApi,
      connectionLocation: loc,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to save" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, connectionLocation: loc });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteBridgeConfig(user.id);
  return NextResponse.json({ ok: true });
}
