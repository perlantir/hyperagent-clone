// P64 + P64.1 — Server-side bridge connection test.
//
// POST /api/codex/test-connection
//
// Behavior depends on the bridge's connectionLocation:
//
//   "browser"      → REFUSE. The hosted server can't reach a localhost
//                    URL on the user's machine. The browser must run
//                    the test itself by opening a WS to the user's
//                    bridge directly. We return 400 with a hint.
//
//   "tunnel"       → Server runs the test. URL was already pre-flight
//                    validated against the SSRF deny-list at write time;
//                    we additionally call verifyResolvedIp() to catch
//                    DNS rebinding into private space at connect time.
//
//   "local-server" → Refused on hosted Vercel (the runtime won't be the
//                    user's machine). Allowed on a non-Vercel host.
//
// Never logs the URL or token. Errors are mapped to user-actionable
// messages; underlying error strings pass through redact() before
// reaching any persistent sink via the AppServerClient's onTrace.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getBridgeConfig } from "@/lib/codex/store";
import { AppServerClient } from "@/lib/codex/app-server";
import { validateForServerSideFetch, verifyResolvedIp } from "@/lib/codex/url-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = await getBridgeConfig(user.id);
  if (!cfg) return NextResponse.json({ error: "No Codex bridge configured" }, { status: 400 });

  const loc = cfg.connectionLocation || "browser";

  // ─── browser-direct: server CAN'T test this — refuse cleanly ──────
  if (loc === "browser") {
    return NextResponse.json({
      ok: false,
      error: "Browser-direct bridges can't be tested from the hosted server. The connection runs in your browser tab. To verify your bridge is up, open the bridge's URL with `wscat` locally or use the browser-side test (coming in P65).",
      requiresBrowserTest: true,
    }, { status: 400 });
  }

  // ─── local-server: only valid when our runtime IS the user's machine ──
  if (loc === "local-server") {
    if (process.env.VERCEL || process.env.VERCEL_ENV) {
      return NextResponse.json({
        ok: false,
        error: "local-server bridge mode is not available on hosted Vercel.",
      }, { status: 400 });
    }
    // Fall through; the bridge URL is loopback-on-this-host which is
    // legitimately our own loopback in this runtime.
  }

  // ─── tunnel: re-validate the URL against the server-side deny-list ──
  if (loc === "tunnel") {
    const v = validateForServerSideFetch(cfg.url);
    if (!v.ok) {
      return NextResponse.json({ ok: false, error: v.reason }, { status: 400 });
    }
    // DNS rebinding guard. The URL passed string-level validation, but
    // a public-looking name could resolve into private space. Refuse if
    // any resolved IP is not public.
    let host = "";
    try { host = new URL(cfg.url).hostname.replace(/^\[|\]$/g, ""); } catch {}
    if (host) {
      const dns = await verifyResolvedIp(host);
      if (!dns.ok) {
        return NextResponse.json({ ok: false, error: dns.reason }, { status: 400 });
      }
    }
  }

  const client = new AppServerClient({
    url: cfg.url,
    capabilityToken: cfg.capabilityToken,
    capabilities: { experimentalApi: cfg.experimentalApi },
  });
  const t0 = Date.now();
  try {
    await client.connect();
    const acct = await client.accountRead();
    const elapsedMs = Date.now() - t0;
    const { accountId: _drop, ...safe } = (acct as any) || {};
    return NextResponse.json({ ok: true, elapsedMs, account: safe, location: loc });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      error: e?.message || "Connection test failed",
      elapsedMs: Date.now() - t0,
    }, { status: 502 });
  } finally {
    try { await client.close(); } catch {}
  }
}
