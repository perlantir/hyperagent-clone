// P26 — list/resolve improvement proposals.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listAllProposals, resolveProposal } from "@/lib/rubric-improvement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const status = url.searchParams.get("status") || undefined;
  const proposals = await listAllProposals(user.id, status, 100);
  return NextResponse.json({ proposals });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { proposalId, status } = body;
  if (!proposalId || !["accepted", "rejected", "superseded"].includes(status)) {
    return NextResponse.json({ error: "proposalId + status (accepted|rejected|superseded) required" }, { status: 400 });
  }
  const r = await resolveProposal(proposalId, user.id, status);
  return NextResponse.json(r);
}
