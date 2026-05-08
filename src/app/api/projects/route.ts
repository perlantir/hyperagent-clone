import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listProjects, createProject } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ projects: await listProjects(user.id) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { name, description, color } = await req.json().catch(() => ({}));
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const p = await createProject({ userId: user.id, name, description: description || "", color: color || "orange" });
  return NextResponse.json({ project: p });
}
