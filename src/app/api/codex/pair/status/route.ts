// P65 — GET /api/codex/pair/status?sessionId=...
//
// Browser polls this every few seconds while waiting for the user's
// companion to claim. Also used after a run to detect when the
// companion drops offline.
//
// Returns: { sessionId, status, online, companionBaseUrl?, companionInfo?, ... }

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPairStatus, PairingError } from "@/lib/codex/pair-store";
import { enforceCsrfReadOnly } from "@/lib/codex/origin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // P65.1 — even though GETs aren't classically CSRFable for state
  // changes, status responses include companion URLs + heartbeat
  // timestamps. Refusing cross-origin GETs ensures a malicious page
  // can't quietly observe paired-session metadata via <img>/<script>
  // shenanigans. (Browsers don't return JSON via those tags, so the
  // attacker can't read the body, but lifting this restriction makes
  // future shape changes safer by default.)
  const csrf = enforceCsrfReadOnly(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const sessionId = String(url.searchParams.get("sessionId") ?? "");
  if (!sessionId) return jsonNoStore({ error: "missing_session_id" }, 400);

  try {
    const view = await getPairStatus({ userId: user.id, sessionId });
    return jsonNoStore(view);
  } catch (e: any) {
    if (e instanceof PairingError) {
      return jsonNoStore({ error: e.code, message: e.message }, 404);
    }
    return jsonNoStore({ error: "status_failed" }, 500);
  }
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
