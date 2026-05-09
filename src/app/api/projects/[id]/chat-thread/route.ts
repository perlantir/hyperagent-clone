// P53 — Get-or-create the canonical "Project chat" thread for a project.
//
// Every project has one persistent chat thread. Opening it lets the user
// converse at the project level — same chat plumbing as a normal thread,
// but pinned to the project so all artifacts auto-attach to the canvas
// and project-scoped memories are in the retrieval set.
//
// We pick the most recent thread in the project whose title starts with
// "Project chat:" (created here) and reuse it. If none exists, we create
// one. This keeps the chat persistent across visits without forcing a
// dedicated DB column.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getProject, listThreads, createThread } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TITLE_PREFIX = "Project chat:";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const project = await getProject(params.id, user.id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  const threads = await listThreads(user.id, params.id);
  const existing = threads.find(t => t.title?.startsWith(TITLE_PREFIX));
  if (existing) return NextResponse.json({ thread: existing, created: false });

  const t = await createThread(
    user.id,
    `${TITLE_PREFIX} ${project.name}`,
    null, // no specific agent — uses the router or the user's default
    params.id,
  );
  return NextResponse.json({ thread: t, created: true });
}
