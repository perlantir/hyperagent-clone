// P25 — single-memory operations.
//   PATCH  /api/memories/{id}  → accept | reject | pin | unpin
//   DELETE /api/memories/{id}  → permanent delete

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { deleteMemory } from "@/lib/db";
import { acceptMemory, rejectMemory, pinMemory } from "@/lib/memory";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = body.action as "accept" | "reject" | "pin" | "unpin" | undefined;

  switch (action) {
    case "accept":
      const a = await acceptMemory(params.id, user.id);
      return NextResponse.json(a);
    case "reject":
      const r = await rejectMemory(params.id, user.id);
      return NextResponse.json(r);
    case "pin":
      return NextResponse.json(await pinMemory(params.id, user.id, true));
    case "unpin":
      return NextResponse.json(await pinMemory(params.id, user.id, false));
    default:
      return NextResponse.json({ error: "action must be accept | reject | pin | unpin" }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteMemory(params.id, user.id);
  await audit({
    userId: user.id, action: "memory.delete", resource: `memory:${params.id}`,
    result: "success", ...auditFromRequest(req),
  });
  return NextResponse.json({ ok: true });
}
