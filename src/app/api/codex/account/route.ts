// P57 — Codex account state via the bridge.
//
//   GET    /api/codex/account                 — account/read passthrough
//   POST   /api/codex/account/login/start     — kick off chatgpt / device-code / apiKey login
//   DELETE /api/codex/account                 — account/logout passthrough
//   GET    /api/codex/account/rate-limits     — account/rateLimits/read passthrough
//
// All four require a configured bridge (see /api/codex/connection). We
// open a fresh AppServerClient per request — Vercel routes are short-
// lived and the bridge handles its own session state. We close the
// client cleanly on the way out.
//
// SECURITY: We never log or trace tokens / login URLs. The trace sink we
// pass to AppServerClient passes through redactRpcEnvelope first.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getBridgeConfig, getProviderMode } from "@/lib/codex/store";
import { AppServerClient } from "@/lib/codex/app-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function withClient<T>(userId: string, fn: (c: AppServerClient) => Promise<T>): Promise<T> {
  const cfg = await getBridgeConfig(userId);
  if (!cfg) throw new Error("No Codex bridge configured. Set one in Settings → Codex.");
  const mode = await getProviderMode(userId);
  // We allow account/* operations on any mode (including openaiApiKey
  // mode the user might switch to — letting them check what's signed in
  // before flipping back to a codex mode). Soft-warn if not in any
  // codex mode.
  const isCodex = mode === "codexChatGPTBridge"
               || mode === "codexChatGPTLocal"
               || mode === "codexChatGPTCompanion";
  if (!isCodex) {
    console.warn(`[codex] account/* called while providerMode=${mode}; not blocking.`);
  }
  const client = new AppServerClient({
    url: cfg.url,
    capabilityToken: cfg.capabilityToken,
    capabilities: { experimentalApi: cfg.experimentalApi },
    onTrace: () => { /* server-side traces wired in P58 */ },
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // P64.2 — real protocol shape is { account: Account | null,
    // requiresOpenaiAuth: boolean }. We surface email + planType only
    // when type==="chatgpt"; api-key sessions and bedrock sessions
    // expose nothing beyond the type.
    const acct = await withClient(user.id, c => c.accountRead({ refreshToken: false }));
    const account = (acct?.account as any) || null;
    const safeAccount = account
      ? {
          type: account.type,
          ...(account.type === "chatgpt"
            ? { email: account.email, planType: account.planType }
            : {}),
        }
      : null;
    return NextResponse.json({
      account: safeAccount,
      requiresOpenaiAuth: !!acct?.requiresOpenaiAuth,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "account/read failed" }, { status: 502 });
  }
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    await withClient(user.id, c => c.accountLogout());
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "account/logout failed" }, { status: 502 });
  }
}
