// P60 — client-error sink.
//
// Receives error reports from the ErrorBoundary so we can audit
// recurring crashes without users having to open devtools. Writes a
// row to the existing audit log so it's queryable from /audit.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Don't require auth — anonymous error reports are useful too.
  const user = await getCurrentUser().catch(() => null);
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { name, message, stack, componentStack, url } = body || {};
  // Truncate to keep audit rows manageable.
  const truncate = (s: any, n: number) => typeof s === "string" ? s.slice(0, n) : "";
  audit({
    userId: user?.id || null,
    action: "client.error",
    result: "error",
    metadata: {
      name: truncate(name, 200),
      message: truncate(message, 1000),
      stack: truncate(stack, 4000),
      componentStack: truncate(componentStack, 4000),
      url: truncate(url, 500),
    },
  }).catch(e => console.error("[client error audit]", e));
  return NextResponse.json({ ok: true });
}
