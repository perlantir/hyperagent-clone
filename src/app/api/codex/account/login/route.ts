// P57 — Codex account/login/start passthrough.
//
//   POST /api/codex/account/login
//   Body: { type: "chatgpt" } | { type: "chatgptDeviceCode" } | { type: "apiKey", apiKey }
//
// Returns the bridge's response (loginUrl for browser flow, userCode +
// verificationUri for device-code, or { } for apiKey if it succeeded
// synchronously). The loginUrl is forwarded as-is so the user's browser
// can navigate to it; we never log it.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getBridgeConfig } from "@/lib/codex/store";
import { AppServerClient } from "@/lib/codex/app-server";
import type { AccountLoginStartParams } from "@/lib/codex/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = await getBridgeConfig(user.id);
  if (!cfg) return NextResponse.json({ error: "No Codex bridge configured." }, { status: 400 });

  const body = await req.json().catch(() => ({})) as AccountLoginStartParams;
  if (body.type !== "chatgpt" && body.type !== "chatgptDeviceCode" && body.type !== "apiKey") {
    return NextResponse.json({ error: "type must be chatgpt | chatgptDeviceCode | apiKey" }, { status: 400 });
  }
  if (body.type === "apiKey" && (!("apiKey" in body) || typeof (body as any).apiKey !== "string")) {
    return NextResponse.json({ error: "apiKey is required when type=apiKey" }, { status: 400 });
  }

  const client = new AppServerClient({
    url: cfg.url,
    capabilityToken: cfg.capabilityToken,
    capabilities: { experimentalApi: cfg.experimentalApi },
  });
  try {
    await client.connect();
    const r = await client.accountLoginStart(body);
    // Pass through. NEVER log r — it carries loginUrl / userCode.
    return NextResponse.json({ login: r });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "login start failed" }, { status: 502 });
  } finally {
    await client.close().catch(() => {});
  }
}
