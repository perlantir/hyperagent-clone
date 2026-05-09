// P63 — Skill detail endpoint.
//
//   GET    /api/skills/<id>  → load a single user-owned skill
//   PATCH  /api/skills/<id>  → edit name / description / category / prompt /
//                              toolHints. Templates are read-only.
//   DELETE /api/skills/<id>  → uninstall (delete the user's skill row).
//                              Templates can't be deleted.
//
// Ownership-scoped: a user can only modify rows where "userId" = their id.
// Templates have userId=null and are surfaced via the catalog GET on the
// list endpoint; they're not addressable here for mutation.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getSkill, updateSkill, deleteSkill } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const s = await getSkill(params.id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Templates are public-readable; user-owned skills require ownership.
  if (s.userId && s.userId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ skill: s });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const existing = await getSkill(params.id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Templates are read-only. Block edits before they hit the DB.
  if (!existing.userId) {
    return NextResponse.json(
      { error: "Built-in templates can't be edited. Install the template first, then edit your copy." },
      { status: 403 },
    );
  }
  if (existing.userId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const patch: any = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.description === "string") patch.description = body.description;
  if (typeof body.category === "string" && body.category.trim()) patch.category = body.category.trim();
  if (typeof body.systemPromptAddition === "string") patch.systemPromptAddition = body.systemPromptAddition;
  if (Array.isArray(body.toolHints)) patch.toolHints = body.toolHints.filter((x: any) => typeof x === "string");
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no editable fields provided" }, { status: 400 });
  }

  const updated = await updateSkill(params.id, user.id, patch);
  return NextResponse.json({ skill: updated });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const existing = await getSkill(params.id);
  if (!existing) return NextResponse.json({ ok: true });
  if (!existing.userId) {
    return NextResponse.json(
      { error: "Built-in templates can't be deleted." },
      { status: 403 },
    );
  }
  if (existing.userId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await deleteSkill(params.id, user.id);
  return NextResponse.json({ ok: true });
}
