// P17 + P35 — Revoke an API key.
//
// Hard-deletes the row (vs. soft-deleting with a revokedAt). Once a key is
// gone it cannot be reactivated; the keyHash is no longer in the table so
// any caller using it gets a 401 from /api/v1/chat.
//
// Audit-logged: api_key.revoke with the key id + name in metadata.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Look up the row first so the audit log has its name (the row is gone
  // by the time the audit fires).
  const row = await pool().query(
    `SELECT name, "keyPrefix" FROM api_keys WHERE id=$1 AND "userId"=$2`,
    [params.id, user.id],
  );
  const r = await pool().query(
    `DELETE FROM api_keys WHERE id=$1 AND "userId"=$2`,
    [params.id, user.id],
  );
  const found = (r.rowCount || 0) > 0;
  await audit({
    userId: user.id,
    action: "api_key.revoke",
    resource: params.id,
    result: found ? "success" : "failure",
    metadata: found ? { name: row.rows[0]?.name, keyPrefix: row.rows[0]?.keyPrefix } : { reason: "not found" },
    ...auditFromRequest(req),
  });
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
