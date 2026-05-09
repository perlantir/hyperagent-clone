import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listArtifactsForUser } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  const includeArchived = u.searchParams.get("includeArchived") === "1";
  return NextResponse.json({
    artifacts: await listArtifactsForUser(user.id, { includeArchived }),
  });
}
