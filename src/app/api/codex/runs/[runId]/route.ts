// P66d — GET /api/codex/runs/:runId
//
// Snapshot read for tab-reopen + active-runs dashboard. Returns the
// run row plus a slice of recent events (last 200) so the UI can
// render where the run is at without immediately opening an SSE
// stream.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { enforceCsrfReadOnly } from "@/lib/codex/origin-guard";
import { getRun } from "@/lib/codex/runs-store";
import { listMirroredEvents } from "@/lib/codex/event-mirror";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { runId: string } }) {
  const csrf = enforceCsrfReadOnly(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);
  const run = await getRun({ runId: params.runId, userId: user.id });
  if (!run) return jsonNoStore({ error: "not_found" }, 404);
  const events = await listMirroredEvents({ userId: user.id, runId: params.runId, limit: 200 });
  return jsonNoStore({ run, events });
}

function jsonNoStore(body: any, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
