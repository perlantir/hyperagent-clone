// P25b — Memory compaction API.
//   GET   /api/memories/compact           → list pending proposals
//   POST  /api/memories/compact           → trigger generation (manual run)
//   PATCH /api/memories/compact           → resolve proposal { proposalId, action: accept|reject }

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  listCompactionProposals,
  generateCompactionProposals,
  applyCompactionProposal,
  rejectCompactionProposal,
} from "@/lib/memory-compaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const status = url.searchParams.get("status") || "pending";
  const proposals = await listCompactionProposals(user.id, status, 50);
  return NextResponse.json({ proposals });
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await generateCompactionProposals(user.id);
  return NextResponse.json(result);
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body.proposalId) return NextResponse.json({ error: "proposalId required" }, { status: 400 });
  if (body.action === "accept") {
    return NextResponse.json(await applyCompactionProposal(body.proposalId, user.id));
  }
  if (body.action === "reject") {
    return NextResponse.json(await rejectCompactionProposal(body.proposalId, user.id));
  }
  return NextResponse.json({ error: "action must be accept | reject" }, { status: 400 });
}
