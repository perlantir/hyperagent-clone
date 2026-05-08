// P27b — cost aggregation endpoint.
//   GET /api/costs?from=...&to=...&groupBy=summary|agent|day|recent
//   Returns the requested rollup. Default `summary`.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { userSummary, perAgentCosts, perDayCosts, recentRuns } from "@/lib/costs";
import { balance } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const groupBy = url.searchParams.get("groupBy") || "summary";
  const from = url.searchParams.get("from") ? Number(url.searchParams.get("from")) : undefined;
  const to = url.searchParams.get("to") ? Number(url.searchParams.get("to")) : undefined;
  const range = { from, to };

  switch (groupBy) {
    case "summary": {
      const [summary, currentBalance] = await Promise.all([
        userSummary(user.id, range),
        balance(user.id),
      ]);
      return NextResponse.json({ summary, balance: currentBalance });
    }
    case "agent":
      return NextResponse.json({ perAgent: await perAgentCosts(user.id, range, 50) });
    case "day":
      return NextResponse.json({ perDay: await perDayCosts(user.id, range, 30) });
    case "recent":
      return NextResponse.json({ recent: await recentRuns(user.id, 50) });
    case "all": {
      const [summary, currentBalance, perAgent, perDay, recent] = await Promise.all([
        userSummary(user.id, range),
        balance(user.id),
        perAgentCosts(user.id, range, 20),
        perDayCosts(user.id, range, 30),
        recentRuns(user.id, 20),
      ]);
      return NextResponse.json({ summary, balance: currentBalance, perAgent, perDay, recent });
    }
    default:
      return NextResponse.json({ error: "groupBy must be summary | agent | day | recent | all" }, { status: 400 });
  }
}
