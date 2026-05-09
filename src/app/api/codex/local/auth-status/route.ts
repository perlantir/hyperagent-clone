// P66b — Local-mode auth probe.
//
// GET /api/codex/local/auth-status
//
// When the app is running locally and Lane A is eligible, the UI
// wants to show whether the user has signed into ChatGPT in codex.
// This endpoint briefly spawns `codex app-server`, runs initialize +
// getAuthStatus, returns the auth state, and shuts the child down
// cleanly.
//
// Response shape:
//
//   { ok: true, authMethod, requiresOpenaiAuth, codexVersion }
//
// authMethod is one of "apikey" | "chatgpt" | "chatgptAuthTokens" |
// "agentIdentity" | null. We never include the raw token.
//
// SECURITY:
//
//   - Only callable by an authenticated user. We do NOT impersonate
//     across users — codex auth state is whatever lives in the host
//     OS's `~/.codex` directory. On a multi-tenant host, do NOT use
//     this; HYPERAGENT_DISABLE_LOCAL_CODEX=1 is the operator's gate.
//
//   - Hosted Vercel returns 400 with `reason: "vercel-hosted"`. We
//     never try to spawn codex on Vercel.
//
//   - We swallow the codex stderr so error logs don't leak codex
//     auth-related strings. The client-facing error message is
//     redacted.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getLocalRuntimeStatus } from "@/lib/codex/local-runtime";
import { createStdioTransport } from "@/lib/codex/transport";
import { AppServerClient } from "@/lib/codex/app-server";
import { emitAuditLog } from "@/lib/codex/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonNoStore({ error: "unauthorized" }, 401);

  const local = getLocalRuntimeStatus();
  if (!local.supportsSpawn) {
    return jsonNoStore({
      ok: false,
      reason: local.reason || "spawn_unavailable",
      message: local.reason === "vercel-hosted"
        ? "This app is hosted on Vercel; local Codex auth probe is not available. Use Companion mode."
        : "This runtime cannot spawn child processes.",
    }, 400);
  }
  if (!local.codexBinary) {
    return jsonNoStore({
      ok: false,
      reason: "codex_binary_missing",
      message: "Install the codex CLI from https://github.com/openai/codex.",
    }, 400);
  }

  let client: AppServerClient | null = null;
  let transport: any = null;
  try {
    transport = await createStdioTransport({ command: local.codexBinary });
    client = new AppServerClient({ transport });
    await client.connect();
    // getAuthStatus is the cheaper of the two; we never include the
    // token in the response (includeToken stays false).
    const auth = await (client as any).getAuthStatus({
      includeToken: false,
      refreshToken: false,
    });
    const authMethod = auth?.authMethod ?? null;
    const requiresOpenaiAuth = auth?.requiresOpenaiAuth === true;

    // Audit emit. Both the "needs login" and "ready" states are
    // info-level; only auth probe failures are errors.
    await emitAuditLog({
      userId: user.id,
      providerMode: "codexChatGPTLocal",
      event: requiresOpenaiAuth ? "local/auth/required" : "local/auth/refreshed",
      severity: "info",
      details: { authMethod },
    });

    return jsonNoStore({
      ok: true,
      authMethod,
      requiresOpenaiAuth,
      codexBinary: local.codexBinary,
    });
  } catch (e: any) {
    await emitAuditLog({
      userId: user.id,
      providerMode: "codexChatGPTLocal",
      event: "local/codex/missing",
      severity: "error",
      details: { message: redactErrorMessage(e?.message || String(e)) },
    });
    return jsonNoStore({
      ok: false,
      reason: "auth_probe_failed",
      message: redactErrorMessage(e?.message || "auth probe failed"),
    }, 502);
  } finally {
    try { await client?.close(); } catch {}
    try { await transport?.close?.(); } catch {}
  }
}

function redactErrorMessage(s: string): string {
  // Cap length and strip anything that smells like a token, path, or
  // env var leakage. The codex binary is verbose on auth errors.
  return String(s)
    .slice(0, 200)
    .replace(/\bBearer\s+[^\s'"]+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[JWT_REDACTED]");
}

function jsonNoStore(body: any, status = 200): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, max-age=0",
    },
  });
}
