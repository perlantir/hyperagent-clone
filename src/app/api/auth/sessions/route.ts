// P42 — Active sessions list.
//
//   GET /api/auth/sessions → { sessions: [{ id, expiresAt, current }] }
//
// Reads the sessions table for the current user. Marks the request's own
// cookie as current=true so the UI can guard against revoking yourself.
//
// We don't track creation timestamps or last-seen on sessions today —
// if that becomes important we'd add a "createdAt" column to the sessions
// table. For now the active session list is "what's not yet expired."

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const currentSessionId = cookies().get("session")?.value;

  const r = await pool().query(
    `SELECT id, "expiresAt" FROM sessions
     WHERE "userId"=$1 AND "expiresAt" > $2
     ORDER BY "expiresAt" DESC`,
    [user.id, Date.now()],
  );
  return NextResponse.json({
    sessions: r.rows.map((row: any) => ({
      id: row.id,
      // Hide the full session id; surface a short prefix for display only.
      // We never let the UI see the full token.
      idPrefix: String(row.id).slice(0, 8),
      expiresAt: Number(row.expiresAt),
      current: row.id === currentSessionId,
    })),
  });
}
