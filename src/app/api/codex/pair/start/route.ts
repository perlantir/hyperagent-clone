// P65 — POST /api/codex/pair/start
//
// User-driven endpoint: creates a fresh pairing session and returns a
// short-lived pair-code the user pastes into the npx companion command.
//
// Body:    none
// Returns: { sessionId, pairCode, expiresAt }
//
// SECURITY:
//   - The pair-code is returned exactly once. It's NOT logged anywhere
//     and NOT persisted in plaintext (the server stores SHA-256 only).
//   - Rate-limited per user: 8 starts per 5 minutes. A user banging the
//     button doesn't accumulate dozens of pending sessions.
//   - The response itself sets Cache-Control: no-store so a forwarding
//     proxy can't cache the pair-code.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { startPairSession } from "@/lib/codex/pair-store";
import { pool } from "@/lib/db";
import { enforceCsrf } from "@/lib/codex/origin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT_MAX = 8;

export async function POST(req: Request) {
  const csrf = enforceCsrf(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Rate-limit gate. Counts pending sessions created in the last window,
  // not just successful claims, so spamming "regenerate" is bounded.
  await ensureSchema();
  const since = Date.now() - RATE_LIMIT_WINDOW_MS;
  const r = await pool().query(
    `SELECT COUNT(*)::int AS n FROM codex_pair_sessions
      WHERE "userId" = $1 AND "createdAt" > $2`,
    [user.id, since],
  );
  if (r.rows[0]?.n >= RATE_LIMIT_MAX) {
    return jsonNoStore({ error: "rate_limited", retryAfterMs: RATE_LIMIT_WINDOW_MS }, 429);
  }

  const { pairCode, sessionId, expiresAt } = await startPairSession({
    userId: user.id,
    orgId: (user as any).orgId ?? null,
  });
  // The response is single-use: we never echo it again. Companion CLI
  // claims directly via /api/codex/pair/claim.
  return jsonNoStore({ sessionId, pairCode, expiresAt });
}

async function ensureSchema(): Promise<void> {
  // Lazy import keeps cold-start lean for routes that don't need pairing.
  const { ensurePairingSchema } = await import("@/lib/codex/pair-store");
  await ensurePairingSchema();
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
