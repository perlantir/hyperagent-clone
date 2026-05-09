// P34 — Sandbox policy endpoint.
//
//   GET   /api/sandbox/policy → { policy, defaults, recentRuns }
//   PATCH /api/sandbox/policy   body: Partial<SandboxPolicy>  → { ok, policy }
//
// Policy is stored on users.preferences.sandboxPolicy. Defaults are baked
// in (DEFAULT_DOMAIN_ALLOWLIST, DEFAULT_CONCURRENCY_CAP, DEFAULT_PER_MINUTE_CAP);
// they're returned alongside the user's effective policy so the UI can
// surface "what would happen if you reset?" without round-tripping.
//
// Recent runs are bundled into GET so the Settings page can show "the
// last few sandboxes" inline.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  getSandboxPolicy, setSandboxPolicy,
  DEFAULT_DOMAIN_ALLOWLIST, DEFAULT_CONCURRENCY_CAP, DEFAULT_PER_MINUTE_CAP,
  listRecentSandboxRuns,
} from "@/lib/sandbox-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [policy, recentRuns] = await Promise.all([
    getSandboxPolicy(user.id),
    listRecentSandboxRuns(user.id, 25),
  ]);
  return NextResponse.json({
    policy,
    defaults: {
      domainAllowlist: DEFAULT_DOMAIN_ALLOWLIST,
      concurrencyCap: DEFAULT_CONCURRENCY_CAP,
      perMinuteCap: DEFAULT_PER_MINUTE_CAP,
    },
    recentRuns,
  });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  const patch: any = {};
  if (Array.isArray(body.domainAllowlist)) {
    // Trim + lowercase + filter empties + cap length.
    const cleaned = body.domainAllowlist
      .map((d: any) => typeof d === "string" ? d.trim().toLowerCase() : "")
      .filter((d: string) => d.length > 0 && d.length < 256)
      .slice(0, 200);
    patch.domainAllowlist = Array.from(new Set(cleaned));
  }
  if (typeof body.concurrencyCap === "number" && body.concurrencyCap > 0 && body.concurrencyCap <= 50) {
    patch.concurrencyCap = body.concurrencyCap;
  }
  if (typeof body.perMinuteCap === "number" && body.perMinuteCap > 0 && body.perMinuteCap <= 1000) {
    patch.perMinuteCap = body.perMinuteCap;
  }
  if (typeof body.failOpen === "boolean") {
    patch.failOpen = body.failOpen;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no valid fields in patch" }, { status: 400 });
  }
  await setSandboxPolicy(user.id, patch);
  return NextResponse.json({ ok: true, policy: await getSandboxPolicy(user.id) });
}
