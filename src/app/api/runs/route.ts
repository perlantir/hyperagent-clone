import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listRuns } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ runs: await listRuns(user.id) });
}
