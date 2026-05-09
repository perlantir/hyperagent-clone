// P41 — Per-agent email inbound addresses.
//
//   GET  /api/agents/{id}/email-addresses → { addresses: [...] }
//   POST /api/agents/{id}/email-addresses { slug? } → { address }
//   (DELETE handled per-address at /api/agents/[id]/email-addresses/[addrId])
//
// Address format: <slug>@<INBOUND_EMAIL_DOMAIN>. Domain comes from
// process.env.INBOUND_EMAIL_DOMAIN; defaults to "agents.hyperagent.app"
// for display when the env var isn't configured (the actual MX setup
// lives at the platform infra level, not in code).

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_DOMAIN = process.env.INBOUND_EMAIL_DOMAIN || "agents.hyperagent.app";

async function ownsAgent(agentId: string, userId: string): Promise<boolean> {
  const r = await pool().query(`SELECT 1 FROM agents WHERE id=$1 AND "userId"=$2`, [agentId, userId]);
  return !!r.rows[0];
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await ownsAgent(params.id, user.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const r = await pool().query(
    `SELECT id, address, "createdAt", "lastReceivedAt", "messageCount"
     FROM agent_email_addresses
     WHERE "agentId"=$1
     ORDER BY "createdAt" ASC`,
    [params.id],
  );
  return NextResponse.json({
    addresses: r.rows.map((row: any) => ({
      ...row,
      createdAt: Number(row.createdAt),
      lastReceivedAt: row.lastReceivedAt ? Number(row.lastReceivedAt) : null,
    })),
    domain: DEFAULT_DOMAIN,
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await ownsAgent(params.id, user.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));

  // Slug rules: 3-32 chars, lowercase alphanumeric + hyphen. Auto-generate
  // a friendly random one if the user doesn't pick.
  let slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  if (!slug) {
    slug = "agent-" + crypto.randomBytes(4).toString("hex");
  }
  if (slug.length < 3) {
    return NextResponse.json({ error: "slug must be at least 3 characters" }, { status: 400 });
  }
  const address = `${slug}@${DEFAULT_DOMAIN}`;

  const id = "ema_" + crypto.randomBytes(8).toString("hex");
  try {
    await pool().query(
      `INSERT INTO agent_email_addresses (id, "userId", "agentId", address, "createdAt")
       VALUES ($1,$2,$3,$4,$5)`,
      [id, user.id, params.id, address, Date.now()],
    );
  } catch (e: any) {
    if (String(e?.message || "").includes("unique")) {
      return NextResponse.json({ error: `address ${address} is already taken — pick another slug` }, { status: 409 });
    }
    throw e;
  }

  await audit({
    userId: user.id, action: "agent.update", resource: params.id,
    result: "success", metadata: { source: "email-address-create", address },
    ...auditFromRequest(req),
  });

  return NextResponse.json({ address: { id, address, agentId: params.id } });
}
