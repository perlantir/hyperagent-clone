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

  // P60 — diagnose missing COMPOSIO_API_KEY up front so users see a real
  // error instead of every toolkit silently returning "no redirect URL".
  if (!process.env.COMPOSIO_API_KEY) {
    return NextResponse.json({
      error: "Composio is not configured on this server. Ask the admin to set the COMPOSIO_API_KEY env var.",
      code: "COMPOSIO_NOT_CONFIGURED",
    }, { status: 503 });
  }

  try {
    const conn = await initiateConnection(user.id, params.id, callbackUrl);
    if (!conn.redirectUrl) {
      // P60 — turn a missing-auth-config status into a useful, actionable
      // message. The most common cause is that the toolkit has no auth
      // config set up in the user's Composio project; the user can
      // create one in the Composio dashboard.
      const slug = params.id;
      const status = conn.status || "unknown";
      const isMissingConfig = /no_auth_config/i.test(status);
      return NextResponse.json({
        error: isMissingConfig
          ? `${slug} has no OAuth auth config set up in this Composio project. Create one in the Composio dashboard, then retry.`
          : `Composio could not initiate ${slug}: ${status}.`,
        code: status,
        helpUrl: "https://platform.composio.dev/auth-configs",
      }, { status: 502 });
    }
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

  await deleteConnection(user.id, match.id);
  return NextResponse.json({ ok: true });
}
