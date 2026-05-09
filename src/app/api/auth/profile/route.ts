// P42 — Profile update.
//
//   PATCH /api/auth/profile  body: { name?, avatar? }
//   → { user }
//
// Edits the current user's display name and (optional) avatar URL.
// Both fields are length-capped server-side. avatar accepts http(s) URL
// or a data: URL (base64-encoded image up to ~512 KB).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let _columnEnsured = false;
async function ensureAvatarColumn() {
  if (_columnEnsured) return;
  await pool().query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT`);
  _columnEnsured = true;
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureAvatarColumn();

  const body = await req.json().catch(() => ({}));
  const updates: string[] = [];
  const vals: any[] = [];

  if (typeof body.name === "string") {
    const name = body.name.trim().slice(0, 80);
    if (name.length === 0) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    vals.push(name);
    updates.push(`name = $${vals.length}`);
  }
  if (typeof body.avatar === "string") {
    const av = body.avatar.trim().slice(0, 1_000_000); // 1MB cap on data URLs
    vals.push(av || null);
    updates.push(`avatar = $${vals.length}`);
  } else if (body.avatar === null) {
    updates.push(`avatar = NULL`);
  }

  if (updates.length === 0) return NextResponse.json({ error: "no valid fields" }, { status: 400 });

  vals.push(user.id);
  await pool().query(
    `UPDATE users SET ${updates.join(", ")} WHERE id = $${vals.length}`,
    vals,
  );

  await audit({
    userId: user.id, action: "agent.update", // closest existing enum — we'll add user.update if this churns
    resource: user.id, result: "success",
    metadata: { source: "profile-update", fields: Object.keys(body) },
    ...auditFromRequest(req),
  });

  const r = await pool().query(`SELECT id, email, name, avatar, "createdAt", "onboardedAt" FROM users WHERE id=$1`, [user.id]);
  return NextResponse.json({ user: r.rows[0] });
}
