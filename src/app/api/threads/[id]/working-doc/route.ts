// P24 — read the per-thread working doc (with parsed plan tasks).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getThread } from "@/lib/db";
import { getWorkingDoc, parsePlanTasks, planProgress } from "@/lib/working-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Ownership check
  const thread = await getThread(params.id, user.id);
  if (!thread) return NextResponse.json({ error: "not found" }, { status: 404 });

  const doc = await getWorkingDoc(params.id);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Parse Plan Tasks for the UI's checkbox component
  const planTasksSection = doc.sections.find(s => s.name.toLowerCase() === "plan tasks");
  const planTasks = planTasksSection ? parsePlanTasks(planTasksSection.content) : [];
  const progress = planProgress(planTasks);

  return NextResponse.json({
    threadId: doc.threadId,
    sections: doc.sections,
    planTasks,
    progress,
    updatedAt: doc.updatedAt,
  });
}
