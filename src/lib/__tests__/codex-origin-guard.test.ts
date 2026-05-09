// P65.1 — Origin/Referer CSRF guard tests.
//
// Verifies enforceCsrf:
//   - Accepts same-origin POST with matching Origin
//   - Accepts POST with no Origin (curl/server-to-server)
//   - Accepts POST with no Origin but matching Referer
//   - Rejects cross-origin POST with foreign Origin
//   - Rejects POST with bad Content-Type
//   - Honors X-Forwarded-Host for forwarding-proxy environments
//   - Rejects POST whose Referer points at a different host

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

import { enforceCsrf, enforceCsrfReadOnly, checkOrigin, checkContentType } from "../codex/origin-guard";

function makeReq(opts: { headers?: Record<string, string> }): Request {
  return new Request("https://app.example.com/api/codex/pair/start", {
    method: "POST",
    headers: opts.headers || {},
  });
}

(async () => {
  // ─── checkOrigin ───────────────────────────────────────────────────
  {
    const r = checkOrigin(makeReq({
      headers: { origin: "https://app.example.com", host: "app.example.com" },
    }));
    pass("same-origin POST passes", r.ok === true);
  }
  {
    const r = checkOrigin(makeReq({
      headers: { origin: "https://attacker.example.com", host: "app.example.com" },
    }));
    pass("cross-origin POST refused",
      r.ok === false && /origin_mismatch/.test(r.reason || ""));
  }
  {
    const r = checkOrigin(makeReq({
      headers: { host: "app.example.com" },
    }));
    pass("no-Origin POST passes (curl / server-to-server)",
      r.ok === true);
  }
  {
    const r = checkOrigin(makeReq({
      headers: { referer: "https://app.example.com/threads/abc", host: "app.example.com" },
    }));
    pass("no-Origin + same-host Referer passes",
      r.ok === true);
  }
  {
    const r = checkOrigin(makeReq({
      headers: { referer: "https://attacker.example.com/x", host: "app.example.com" },
    }));
    pass("no-Origin + foreign Referer refused",
      r.ok === false && /referer_mismatch/.test(r.reason || ""));
  }
  {
    const r = checkOrigin(makeReq({
      headers: { origin: "https://app.example.com", "x-forwarded-host": "app.example.com", host: "vercel.internal" },
    }));
    pass("X-Forwarded-Host honored over raw Host",
      r.ok === true);
  }
  {
    const r = checkOrigin(makeReq({
      headers: { origin: "https://app.example.com", "x-forwarded-host": "app.example.com:443", host: "vercel.internal" },
    }));
    pass("port-mismatch on x-forwarded-host correctly refused",
      r.ok === false);
  }

  // ─── checkContentType ──────────────────────────────────────────────
  {
    const r = checkContentType(makeReq({ headers: { "content-type": "application/json" } }));
    pass("application/json passes", r.ok === true);
  }
  {
    const r = checkContentType(makeReq({ headers: { "content-type": "application/json; charset=utf-8" } }));
    pass("application/json with charset passes", r.ok === true);
  }
  {
    const r = checkContentType(makeReq({ headers: { "content-type": "text/plain" } }));
    pass("text/plain refused", r.ok === false);
  }
  {
    const r = checkContentType(makeReq({}));
    pass("missing content-type refused", r.ok === false);
  }

  // ─── enforceCsrf integration ──────────────────────────────────────
  {
    const r = enforceCsrf(makeReq({
      headers: { origin: "https://app.example.com", host: "app.example.com", "content-type": "application/json" },
    }));
    pass("enforceCsrf passes same-origin JSON POST", r === null);
  }
  {
    const r = enforceCsrf(makeReq({
      headers: { origin: "https://attacker.example.com", host: "app.example.com", "content-type": "application/json" },
    }));
    pass("enforceCsrf returns 403 on cross-origin",
      r !== null && r.status === 403);
  }
  {
    const r = enforceCsrf(makeReq({
      headers: { origin: "https://app.example.com", host: "app.example.com", "content-type": "text/plain" },
    }));
    pass("enforceCsrf returns 415 on bad content-type",
      r !== null && r.status === 415);
  }
  {
    const r = enforceCsrfReadOnly(makeReq({
      headers: { origin: "https://app.example.com", host: "app.example.com" },
    }));
    pass("enforceCsrfReadOnly passes same-origin GET", r === null);
  }
  {
    const r = enforceCsrfReadOnly(makeReq({
      headers: { origin: "https://attacker.example.com", host: "app.example.com" },
    }));
    pass("enforceCsrfReadOnly returns 403 on cross-origin",
      r !== null && r.status === 403);
  }

  // ─── server-side fetch with no Origin AND no Referer is allowed ───
  // (this is the curl / Node fetch / other-server case; not a browser
  // CSRF threat).
  {
    const r = enforceCsrf(makeReq({
      headers: { host: "app.example.com", "content-type": "application/json" },
    }));
    pass("enforceCsrf passes server-to-server (no Origin, no Referer)",
      r === null);
  }

  if (failed > 0) {
    console.error(`\n${failed} origin-guard test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-origin-guard tests passed");
})();
