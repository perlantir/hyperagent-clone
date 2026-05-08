import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getConnector } from "@/lib/connectors";
import { upsertConnectorCredentials, deleteConnectorCredentials } from "@/lib/db";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conn = getConnector(params.id);
  if (!conn) return NextResponse.json({ error: "unknown connector" }, { status: 404 });
  const { credentials, label } = await req.json().catch(() => ({}));
  if (!credentials) return NextResponse.json({ error: "credentials required" }, { status: 400 });
  // Validate required fields.
  for (const f of conn.credentialFields) {
    if (!credentials[f.name]) return NextResponse.json({ error: `${f.label} required` }, { status: 400 });
  }
  const cc = await upsertConnectorCredentials(user.id, params.id, label || conn.name, credentials);
  return NextResponse.json({ ok: true, id: cc.id });
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteConnectorCredentials(user.id, params.id);
  return NextResponse.json({ ok: true });
}
