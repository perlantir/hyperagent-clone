// P41 — Per-agent webhook signing secret.
//
//   GET    /api/agents/{id}/webhook-secret → { secret: "whsec_..." | null }
//   POST   /api/agents/{id}/webhook-secret → { secret }   (rotate / generate)
//   DELETE /api/agents/{id}/webhook-secret → { ok }       (clear; back to bearer-auth only)
//
// When set, /api/v1/agents/[id]/invoke accepts HMAC-SHA256 signed requests
// as an alternative to API-key auth. The signature is computed as:
//   X-Hyperagent-Signature: t=<unix_ts>,v1=<hex_hmac>
//   payload = "<unix_ts>.<raw_body>"
// The Stripe convention. 5-minute clock skew tolerance enforced server-side.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function ownsAgent(agentId: string, userId: string): Promise<boolean> {
  const r = await pool().query(`SELECT 1 FROM agents WHERE id=$1 AND "userId"=$2`, [agentId, userId]);
  return !!r.rows[0];
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await ownsAgent(params.id, user.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const r = await pool().query(`SELECT "webhookSecret" FROM agents WHERE id=$1`, [params.id]);
  return NextResponse.json({ secret: r.rows[0]?.webhookSecret || null });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await ownsAgent(params.id, user.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const secret = "whsec_" + crypto.randomBytes(24).toString("base64url");
  await pool().query(`UPDATE agents SET "webhookSecret"=$1 WHERE id=$2`, [secret, params.id]);
  await audit({
    userId: user.id, action: "agent.update", resource: params.id,
    result: "success", metadata: { source: "webhook-secret-rotate" },
    ...auditFromRequest(req),
  });
  return NextResponse.json({ secret });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await ownsAgent(params.id, user.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  await pool().query(`UPDATE agents SET "webhookSecret"=NULL WHERE id=$1`, [params.id]);
  await audit({
    userId: user.id, action: "agent.update", resource: params.id,
    result: "success", metadata: { source: "webhook-secret-clear" },
    ...auditFromRequest(req),
  });
  return NextResponse.json({ ok: true });
}
