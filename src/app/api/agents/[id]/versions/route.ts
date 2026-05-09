// P28b — Agent version history + rollback.
//
//   GET  /api/agents/{id}/versions   → { versions: [...] }
//   POST /api/agents/{id}/versions   body: { version: N, note? } → { ok: true, newVersion }
//
// POST takes a version number, restores the agent to that snapshot, and
// writes a NEW snapshot reflecting the rollback so the rollback itself is
// reversible.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listAgentVersions, rollbackAgentToVersion } from "@/lib/agent-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const versions = await listAgentVersions(params.id, user.id);
  return NextResponse.json({ versions });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { version, note } = await req.json().catch(() => ({}));
  if (typeof version !== "number") {
    return NextResponse.json({ error: "version (number) required" }, { status: 400 });
  }
  const r = await rollbackAgentToVersion(params.id, user.id, version, note);
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  return NextResponse.json({ ok: true, newVersion: r.newVersion });
}
