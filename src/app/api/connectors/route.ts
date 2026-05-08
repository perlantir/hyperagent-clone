import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listConnectors } from "@/lib/connectors";
import { listConnectorCredentials } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const connectors = listConnectors();
  const creds = await listConnectorCredentials(user.id);
  const connectedIds = new Set(creds.map(c => c.connectorId));
  return NextResponse.json({
    connectors: connectors.map(c => ({ ...c, connected: connectedIds.has(c.id) })),
  });
}
