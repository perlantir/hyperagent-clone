// P26 — single rubric: GET, PATCH (pin/unpin), DELETE (user-owned only)

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRubric } from "@/lib/rubrics";
import { pool } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rubric = await getRubric(params.id, user.id);
  if (!rubric) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ rubric });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const action = body.action as "pin" | "unpin" | "update" | undefined;

  const existing = await getRubric(params.id, user.id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (action === "pin" || action === "unpin") {
    await pool().query(
      `UPDATE rubrics SET "isPinned"=$2, "updatedAt"=$3 WHERE id=$1`,
      [params.id, action === "pin", Date.now()],
    );
    return NextResponse.json({ ok: true, isPinned: action === "pin" });
  }

  if (action === "update") {
    if (existing.isBuiltin) {
      return NextResponse.json({ error: "cannot modify builtin rubrics" }, { status: 403 });
    }
    await pool().query(`
      UPDATE rubrics
      SET name = COALESCE($2, name),
          description = COALESCE($3, description),
          criteria = COALESCE($4::jsonb, criteria),
          "passingThreshold" = COALESCE($5, "passingThreshold"),
          "judgePassingScore" = COALESCE($6, "judgePassingScore"),
          version = version + 1,
          "updatedAt" = $7
      WHERE id=$1 AND "userId"=$8
    `, [
      params.id, body.name || null, body.description || null,
      body.criteria ? JSON.stringify(body.criteria) : null,
      body.passingThreshold ?? null, body.judgePassingScore ?? null,
      Date.now(), user.id,
    ]);
    return NextResponse.json(await getRubric(params.id, user.id));
  }

  return NextResponse.json({ error: "action must be pin | unpin | update" }, { status: 400 });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const existing = await getRubric(params.id, user.id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.isBuiltin) {
    return NextResponse.json({ error: "cannot delete builtin rubrics" }, { status: 403 });
  }
  await pool().query(`DELETE FROM rubrics WHERE id=$1 AND "userId"=$2`, [params.id, user.id]);
  return NextResponse.json({ ok: true });
}
