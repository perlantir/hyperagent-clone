// P31b — Artifact version history.
//   GET  /api/artifacts/{id}/versions   → { versions: [...] }
//   POST /api/artifacts/{id}/versions   body: { version: N }
//                                        → restore that version (snapshots
//                                          current state first, then writes)

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getArtifact, getThread, listArtifactVersions, updateArtifactBody, pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const a = await getArtifact(params.id);
  if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
  const t = await getThread(a.threadId, user.id);
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
  const versions = await listArtifactVersions(params.id);
  return NextResponse.json({ versions });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const a = await getArtifact(params.id);
  if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
  const t = await getThread(a.threadId, user.id);
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { version } = await req.json().catch(() => ({}));
  if (typeof version !== "number") {
    return NextResponse.json({ error: "version (number) required" }, { status: 400 });
  }
  // Look up the target snapshot.
  const r = await pool().query(
    `SELECT title, body FROM artifact_versions WHERE "artifactId"=$1 AND version=$2`,
    [params.id, version],
  );
  const target = r.rows[0];
  if (!target) return NextResponse.json({ error: `version ${version} not found` }, { status: 404 });

  // updateArtifactBody snapshots current state before writing — so the
  // pre-rollback row is captured and the rollback itself is reversible.
  const u = await updateArtifactBody(params.id, {
    title: target.title,
    body: target.body,
    changeNote: `restored from v${version}`,
  });
  if (!u.ok) return NextResponse.json({ error: "rollback failed" }, { status: 500 });
  return NextResponse.json({ ok: true, newVersion: u.newVersion });
}
