// Lists Composio toolkits + the user's currently connected accounts.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listToolkits, listConnectedAccounts } from "@/lib/composio";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [toolkits, accounts] = await Promise.all([
    listToolkits(),
    listConnectedAccounts(user.id),
  ]);

  // Index user's connected accounts by toolkit slug.
  const connectedMap: Record<string, any> = {};
  for (const acc of accounts) {
    const slug = acc.toolkit?.slug || acc.appName || acc.app_name;
    if (slug) connectedMap[slug] = { id: acc.id, status: acc.status, createdAt: acc.createdAt };
  }

  return NextResponse.json({
    connectors: toolkits.map(t => ({
      ...t,
      connected: !!connectedMap[t.slug],
      connection: connectedMap[t.slug] || null,
    })),
  });
}
