// P66c — POST /api/codex/companions/:id/revoke
//
// User-initiated companion device revocation. Sets `revokedAt`, flips
// `enabledForRuns: false`. Future relay /dispatch attempts will see
// the row revoked and refuse forwarding.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { revokeCompanion } from "@/lib/codex/companions-store";
import { enforceCsrf } from "@/lib/codex/origin-guard";
import { emitAuditLog } from "@/lib/codex/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const csrf = enforceCsrf(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);
  const ok = await revokeCompanion({ companionId: params.id, userId: user.id });
  await emitAuditLog({
    userId: user.id,
    companionId: params.id,
    event: "companion/revoked",
    severity: ok ? "info" : "warn",
    details: { found: ok },
  });
  return jsonNoStore({ ok });
}

function jsonNoStore(body: any, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
