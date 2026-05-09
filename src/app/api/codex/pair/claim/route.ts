// P65 — POST /api/codex/pair/claim
//
// Companion-driven endpoint: a local companion process claims a pairing
// session by presenting the pair-code the user typed in.
//
// Body:    { pairCode, companionBaseUrl, companionInfo? }
// Returns: { sessionId, sessionSecret, expiresAt }
//
// AUTH model: this is a per-user authenticated call. Even though the
// companion is "the user's local process", the user's BROWSER is the
// session-bearing client — the companion uses the browser's session
// cookie via fetch() to the hosted app. (If the user is signed out, the
// companion CLI can't claim; the UI gates on this.)
//
// In practice: when the user clicks "Install companion", the UI prints
// a curl/npx command that hits this endpoint with the user's session
// cookie attached. The companion either runs in the same browser
// session (npx CLI prompts the user to copy a cookie OR uses a
// cookieless flow scoped to the pair-code).
//
// For P65 alpha we use the COOKIELESS path: the pair-code itself is
// the auth proof. The /pair/start endpoint already required a user
// session and bound the pair-code to that user. So claim only needs
// the pair-code — the userId is recovered from the pair-code's row.
//
// This means we DON'T require getCurrentUser() here. We DO require the
// caller to come from the public internet (no special trust). Pair
// codes are 192-bit and expire in 5 minutes; brute-forcing is not
// feasible.
//
// SECURITY:
//   - We accept the claim from anywhere and rely on pair-code entropy
//     for authentication.
//   - The companion URL must be loopback (validated by claimPairSession).
//   - Response is no-store so a forwarding proxy can't cache the secret.

import { NextResponse } from "next/server";
import { claimPairSession, PairingError } from "@/lib/codex/pair-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "invalid_json" }, 400);
  }
  const pairCode = String(body?.pairCode ?? "");
  const companionBaseUrl = String(body?.companionBaseUrl ?? "");
  const companionInfo = body?.companionInfo;
  if (!pairCode || pairCode.length < 16 || pairCode.length > 256) {
    return jsonNoStore({ error: "invalid_pair_code" }, 400);
  }
  if (!companionBaseUrl) {
    return jsonNoStore({ error: "missing_companion_url" }, 400);
  }

  // We don't authenticate the caller — the pair-code IS the auth.
  // We pull the bound userId out of the database via the row keyed on
  // the pair-code hash inside claimPairSession.
  try {
    // claimPairSession requires a userId to constant-time compare
    // against the row. We pass through what claim itself reads — by
    // using a sentinel "<lookup>", we tell the helper to bind to the
    // row's user. To keep the pair-store API simple, we look up the
    // userId here first.
    const { findUserIdByPairCode } = await import("@/lib/codex/pair-store-internal");
    const userId = await findUserIdByPairCode(pairCode);
    if (!userId) {
      return jsonNoStore({ error: "invalid_pair_code" }, 400);
    }
    const r = await claimPairSession({
      userId,
      pairCode,
      companionBaseUrl,
      companionInfo,
    });
    return jsonNoStore(r);
  } catch (e: any) {
    if (e instanceof PairingError) {
      const status = e.code === "wrong_user" || e.code === "non_loopback_companion_url" ? 400 : 400;
      return jsonNoStore({ error: e.code, message: e.message }, status);
    }
    return jsonNoStore({ error: "claim_failed" }, 500);
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
