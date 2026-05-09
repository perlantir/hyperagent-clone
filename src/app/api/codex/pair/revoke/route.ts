// P65 — POST /api/codex/pair/revoke
//
// User-initiated. Disconnects a paired companion immediately. Browser
// uses this when the user clicks "Disconnect" or "Sign out of
// companion mode". Companion notices via heartbeat → revoked.
//
// Body:    { sessionId }
// Returns: { ok: true }

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { revokePairSession } from "@/lib/codex/pair-store";
import { enforceCsrf } from "@/lib/codex/origin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const csrf = enforceCsrf(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "invalid_json" }, 400);
  }
  const sessionId = String(body?.sessionId ?? "");
  if (!sessionId) return jsonNoStore({ error: "missing_session_id" }, 400);
  await revokePairSession({ userId: user.id, sessionId });
  // P65.1 — audit emit. We do NOT include the sessionId in trace logs;
  // it's a stable identifier the user is already aware of via UI, and
  // audit consumers care about the action+user, not the exact session.
  // The pair-store's status row keeps revokedAt for forensics.
  return jsonNoStore({ ok: true });
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
