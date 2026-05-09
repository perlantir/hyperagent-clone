// P42 — Revoke a specific session.
//
//   DELETE /api/auth/sessions/{id}
//
// Authz: user can only revoke their own sessions. Revoking the current
// session is allowed (caller will get a 401 on the next request).

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const currentSessionId = cookies().get("session")?.value;

  const r = await pool().query(
    `DELETE FROM sessions WHERE id=$1 AND "userId"=$2`,
    [params.id, user.id],
  );
  const found = (r.rowCount || 0) > 0;
  await audit({
    userId: user.id, action: "auth.logout",
    resource: params.id, result: found ? "success" : "failure",
    metadata: { source: "session-revoke", isCurrent: params.id === currentSessionId },
    ...auditFromRequest(req),
  });
  return NextResponse.json({ ok: found });
}
