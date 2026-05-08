// DELETE /api/settings/slack-workspaces/{teamId} — unbind a workspace.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: { teamId: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await pool().query(
    `DELETE FROM slack_workspaces WHERE team_id=$1 AND "userId"=$2`,
    [params.teamId, user.id],
  );
  return NextResponse.json({ ok: true });
}
