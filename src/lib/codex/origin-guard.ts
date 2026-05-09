// P65.1 — Origin/Referer guard for Codex pair routes.
//
// Background. The /api/codex/pair/* routes that mutate state — pair/start,
// pair/revoke — and the run-ticket issue endpoint use the user's session
// cookie as the auth signal. Without an additional defense, a logged-in
// user visiting a malicious page could trigger:
//
//   - POST https://app.example.com/api/codex/pair/start
//       The browser attaches the session cookie. The hosted app issues
//       a pair-code that the malicious page can't read (CORS blocks
//       the response) BUT the side effect — a pair session in pending
//       state — is real.
//
//   - POST https://app.example.com/api/codex/pair/revoke
//       Same pattern; the attacker can mass-revoke a victim's
//       sessions.
//
//   - POST https://app.example.com/api/codex/run-ticket
//       Issues a ticket the attacker can't read but mutates trace
//       state.
//
// Mitigations applied here:
//
//   1. **Origin / Referer header check.** Every same-origin browser
//      POST sets one of these headers automatically. Cross-origin
//      forged POSTs from an attacker page set `Origin` to the
//      attacker's origin. We compare the inbound Origin (or fallback
//      Referer) against the request's own Host header. If they don't
//      agree, refuse.
//
//   2. **Content-Type enforcement.** All mutating routes here expect
//      `Content-Type: application/json`. Browsers cannot send that
//      content-type cross-origin without a CORS preflight, and we
//      respond to OPTIONS preflights with no Access-Control-Allow-*
//      headers, which means the preflight fails and the actual POST
//      never fires.
//
//   3. **Session cookie attribute.** The session cookie should be
//      configured with `SameSite=Lax` (the platform default in our
//      auth setup). Lax already blocks cross-site POSTs from forms
//      via top-level navigation. We treat this as belt-AND-suspenders
//      with #1 + #2, not as a sole defense.
//
// What this guard does NOT replace:
//
//   - Cookie-less endpoints (`/pair/claim`, `/pair/heartbeat`,
//     `/events`) authenticate via a high-entropy token (pair-code,
//     sessionSecret, run-ticket signature) so they don't need CSRF.
//     Their auth is bound to the message body, not to ambient cookies.
//
//   - DDoS / brute force. Rate limits are layered separately on
//     `/pair/start`. Other write endpoints inherit the per-user
//     scoping via the route's own logic.
//
// Helper returns null on success; on failure returns a NextResponse
// the route can return directly.

import { NextResponse } from "next/server";

export interface OriginGuardResult {
  ok: boolean;
  reason?: string;
}

export function checkOrigin(req: Request): OriginGuardResult {
  // Allow internal Next.js fetches that don't carry Origin/Referer when
  // they hit our route from the same Node process. Those requests look
  // like server-side fetch() calls — no Origin header — and they're
  // outside the browser CSRF threat model.
  //
  // SECURITY: We require EITHER (a) a same-origin Origin/Referer header,
  // OR (b) no Origin header at all (server-side / curl). Browsers can't
  // suppress the Origin header on cross-origin POSTs, so the absence of
  // Origin combined with a present cookie indicates a non-browser
  // request (curl, server-to-server). That's an acceptable shape for
  // our routes; we deny only EXPLICITLY-cross-origin browser requests.
  const origin = (req.headers.get("origin") || "").trim();
  const referer = (req.headers.get("referer") || "").trim();
  const host = (req.headers.get("host") || "").trim();
  // Forwarding-proxy aware: prefer x-forwarded-host when set.
  const xfHost = (req.headers.get("x-forwarded-host") || "").trim();
  const expectedHost = xfHost || host;
  if (!expectedHost) {
    return { ok: false, reason: "missing_host" };
  }

  // Helper: does origin/referer URL match our host?
  const matchesHost = (raw: string): boolean => {
    if (!raw) return false;
    try {
      const u = new URL(raw);
      return u.host === expectedHost;
    } catch {
      return false;
    }
  };

  if (origin) {
    if (matchesHost(origin)) return { ok: true };
    return { ok: false, reason: `origin_mismatch:${origin}` };
  }
  // No Origin header. Some browsers (older Safari) omit Origin on
  // same-site GETs/POSTs but always set Referer. Validate that.
  if (referer) {
    if (matchesHost(referer)) return { ok: true };
    return { ok: false, reason: `referer_mismatch:${referer}` };
  }
  // Neither Origin nor Referer. This is server-side fetch / curl /
  // tooling territory. We allow it — there's no CSRF threat from a
  // non-browser caller. (Native apps using session cookies are also
  // covered: they typically don't send Origin.)
  return { ok: true };
}

export function checkContentType(req: Request, expected = "application/json"): OriginGuardResult {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith(expected)) {
    return { ok: false, reason: `bad_content_type:${ct || "(none)"}` };
  }
  return { ok: true };
}

// Combined helper — applies both checks in order. Pair routes that
// mutate state should call this first thing.
export function enforceCsrf(req: Request): NextResponse | null {
  const o = checkOrigin(req);
  if (!o.ok) {
    return new NextResponse(
      JSON.stringify({ error: "csrf_origin_check_failed", reason: o.reason }),
      { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }
  const c = checkContentType(req);
  if (!c.ok) {
    return new NextResponse(
      JSON.stringify({ error: "csrf_content_type_check_failed", reason: c.reason }),
      { status: 415, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }
  return null;
}

// GET-only variant. Just enforce origin if present (read-only routes
// don't strictly need CSRF, but we still gate cross-origin for
// defense-in-depth). Skipping content-type since GETs have none.
export function enforceCsrfReadOnly(req: Request): NextResponse | null {
  const o = checkOrigin(req);
  if (!o.ok) {
    return new NextResponse(
      JSON.stringify({ error: "csrf_origin_check_failed", reason: o.reason }),
      { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }
  return null;
}
