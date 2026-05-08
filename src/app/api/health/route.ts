// Health & capability probe (P22 QA).
// Returns the deployment SHA, runtime, and which provider keys are configured
// (without leaking values). Useful for diagnosing prod issues without poking
// around the dashboard.

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
    capabilities: {
      anthropic: has("ANTHROPIC_API_KEY"),
      database: has("DATABASE_URL"),
      cron: has("CRON_SECRET"),
      composio: has("COMPOSIO_API_KEY"),
      hyperbrowser: has("HYPERBROWSER_API_KEY"),
      gemini: has("GEMINI_API_KEY"),
      openai: has("OPENAI_API_KEY"),
      grok: has("XAI_API_KEY"),
      stripe: has("STRIPE_SECRET_KEY"),
      stripe_webhook: has("STRIPE_WEBHOOK_SECRET"),
      slack: has("SLACK_SIGNING_SECRET"),
    },
  });
}
