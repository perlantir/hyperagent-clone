// P47 — list all callable actions for a Composio toolkit slug.
//
// Powers the per-action permissioning UI in the agent builder's
// Integrations tab: GET /api/connectors/<slug>/actions returns the full
// catalogue (up to 200 entries) so the user can check the boxes for
// the specific actions they want to expose to this agent.
//
// Each entry is { name, description } — the UI doesn't need the full
// JSON schema for picking, just the human-readable label.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listToolsForToolkit } from "@/lib/composio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dynamic param is named `id` to share the parent /api/connectors/[id]
// dynamic segment — we just treat it as the toolkit slug.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const slug = params.id?.toLowerCase();
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  const tools = await listToolsForToolkit(user.id, slug, 200);
  return NextResponse.json({
    actions: tools.map(t => ({
      name: t.name,
      description: t.description?.slice(0, 240) || "",
    })),
  });
}
