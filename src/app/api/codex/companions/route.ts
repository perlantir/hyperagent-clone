// P66c — GET /api/codex/companions
//
// Returns the user's registered companion devices for Settings UI.
// Cookie-authenticated. Read-only; no CSRF needed.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listCompanionsForUser } from "@/lib/codex/companions-store";
import { enforceCsrfReadOnly } from "@/lib/codex/origin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const csrf = enforceCsrfReadOnly(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);
  const companions = await listCompanionsForUser(user.id);
  return jsonNoStore({ companions });
}

function jsonNoStore(body: any, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
