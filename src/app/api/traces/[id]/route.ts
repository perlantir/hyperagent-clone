// P28a — single trace run + its events.
//   GET /api/traces/{runId}  → { run, events: [...] }
//
// Used by the future replay/fork UI (P28b) and any debugging tooling.
// Scoped to the requesting user.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRun, getEventsForRun } from "@/lib/traces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const run = await getRun(params.id, user.id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const events = await getEventsForRun(params.id, user.id);
  return NextResponse.json({ run, events });
}
