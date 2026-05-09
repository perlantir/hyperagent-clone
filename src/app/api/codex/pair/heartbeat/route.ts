// P65 — POST /api/codex/pair/heartbeat
//
// Companion-driven. The companion POSTs every ~30 seconds with
// { sessionId, sessionSecret, companionInfo? }. We update
// lastHeartbeatAt and return { ok: true, expiresAt }.
//
// AUTH: the sessionSecret returned at claim is the per-companion
// secret. We compare via timingSafeEqual against the stored hash.
// No user cookie is needed — the secret IS the auth.

import { NextResponse } from "next/server";
import { heartbeatPairSession } from "@/lib/codex/pair-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "invalid_json" }, 400);
  }
  const sessionId = String(body?.sessionId ?? "");
  const sessionSecret = String(body?.sessionSecret ?? "");
  const companionInfo = body?.companionInfo;
  if (!sessionId || !sessionSecret) {
    return jsonNoStore({ error: "missing_credentials" }, 400);
  }
  const r = await heartbeatPairSession({ sessionId, sessionSecret, companionInfo });
  if (!r.ok) {
    // Map specific reasons to status codes for the companion's UX.
    const status = r.reason === "bad_secret" ? 401
                 : r.reason === "expired" || r.reason === "revoked" || r.reason === "not_found" ? 410
                 : 400;
    return jsonNoStore({ error: r.reason }, status);
  }
  return jsonNoStore({ ok: true, expiresAt: r.expiresAt });
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
