// Health & capability probe.
// Returns deployment metadata and which provider keys are present at the
// platform (env-var) level. Per-user keys are surfaced via /api/settings/secrets.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const has = (k: string) => !!process.env[k];
  return NextResponse.json({
    ok: true,
    sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    region: process.env.VERCEL_REGION || null,
    nodeVersion: process.version,
    note: "Per-user keys override env-var fallbacks. Visit /settings → API Keys to BYO.",
    capabilities: {
      // Platform infra
      database: has("DATABASE_URL"),
      cron: has("CRON_SECRET"),
      encryption: has("ENCRYPTION_KEY"),
      // Provider env-var fallbacks (false = users MUST set their own key in Settings)
      anthropic_fallback: has("ANTHROPIC_API_KEY"),
      openai_fallback: has("OPENAI_API_KEY"),
      gemini_fallback: has("GEMINI_API_KEY"),
      grok_fallback: has("XAI_API_KEY"),
      hyperbrowser_fallback: has("HYPERBROWSER_API_KEY"),
      composio_fallback: has("COMPOSIO_API_KEY"),
      e2b_fallback: has("E2B_API_KEY"),
      // Platform-only secrets (host-side, not user-scoped)
      stripe: has("STRIPE_SECRET_KEY"),
      stripe_webhook: has("STRIPE_WEBHOOK_SECRET"),
      slack_webhook: has("SLACK_SIGNING_SECRET"),
      liveblocks_server: has("LIVEBLOCKS_SECRET_KEY"),
      liveblocks_client: has("NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY"),
    },
  });
}
