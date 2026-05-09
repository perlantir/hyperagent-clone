// P44 — Bulk archive / unarchive / delete for /library multi-select.
//
//   POST /api/artifacts/bulk { ids: string[], action: "archive"|"unarchive"|"delete" }
//   → { ok, touched }

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { archiveArtifacts, pool } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
  const action: string = body.action;
  if (ids.length === 0) return NextResponse.json({ error: "ids required" }, { status: 400 });
  if (!["archive", "unarchive", "delete"].includes(action)) {
    return NextResponse.json({ error: "action must be archive | unarchive | delete" }, { status: 400 });
  }

  let touched = 0;
  if (action === "archive") {
    touched = await archiveArtifacts(ids, user.id, true);
  } else if (action === "unarchive") {
    touched = await archiveArtifacts(ids, user.id, false);
  } else if (action === "delete") {
    const r = await pool().query(
      `DELETE FROM artifacts a
       USING threads t
       WHERE a.id = ANY($1::text[])
         AND a."threadId" = t.id
         AND t."userId" = $2`,
      [ids, user.id],
    );
    touched = r.rowCount || 0;
  }

  await audit({
    userId: user.id, action: "thread.delete",  // closest enum; bulk-artifact-mutate
    resource: null, result: "success",
    metadata: { source: "library-bulk", action, requested: ids.length, touched },
    ...auditFromRequest(req),
  });

  return NextResponse.json({ ok: true, touched });
}
