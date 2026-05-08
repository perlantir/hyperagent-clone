// Initiate or disconnect a Composio connection.
//
// POST  /api/connectors/{toolkitSlug}  → returns redirect URL for OAuth
// DELETE /api/connectors/{toolkitSlug} → deletes the user's connection

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { initiateConnection, listConnectedAccounts, deleteConnection } from "@/lib/composio";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const callbackUrl = `${url.origin}/integrations?connected=${encodeURIComponent(params.id)}`;

  try {
    const conn = await initiateConnection(user.id, params.id, callbackUrl);
    return NextResponse.json(conn);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to initiate" }, { status: 500 });
  }
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const accounts = await listConnectedAccounts(user.id);
  const match = accounts.find((a: any) => (a.toolkit?.slug || a.appName || a.app_name) === params.id);
  if (!match) return NextResponse.json({ ok: true });

  await deleteConnection(match.id);
  return NextResponse.json({ ok: true });
}
