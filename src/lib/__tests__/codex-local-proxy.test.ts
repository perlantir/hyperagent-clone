// P66e — Local proxy scaffolding tests.
//
// Covers the eligibility gate, PKCE/state helpers, and the in-memory
// token vault. The actual ChatGPT integration (HTTP server, OAuth
// callback, model normalization, SSE conversion) lives in the
// companion package; testing there requires a live OAuth flow which
// is out of scope here.
//
// These tests verify the SCAFFOLDING:
//   - feature flag gate
//   - Vercel rejection
//   - non-loopback binds refused without iUnderstand
//   - PKCE + state crypto: round-trip + tampered values
//   - in-memory vault read/write/clear

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

import {
  isLocalProxyFeatureEnabled,
  checkLocalProxyEligibility,
  newOAuthChallenge,
  verifyOAuthState,
  createInMemoryVault,
  FEATURE_FLAG_NAME,
  DEFAULT_LOCAL_PROXY_CONFIG,
  LOCAL_PROXY_PROVIDER_MODE,
} from "../codex/local-proxy";

(async () => {
  // ─── feature flag gate ────────────────────────────────────────────
  pass("flag off by default",
    isLocalProxyFeatureEnabled({}) === false);
  pass("flag accepts '1'",
    isLocalProxyFeatureEnabled({ [FEATURE_FLAG_NAME]: "1" }) === true);
  pass("flag accepts 'true'",
    isLocalProxyFeatureEnabled({ [FEATURE_FLAG_NAME]: "true" }) === true);
  pass("flag rejects other values",
    isLocalProxyFeatureEnabled({ [FEATURE_FLAG_NAME]: "yes" }) === false);

  // ─── eligibility ──────────────────────────────────────────────────
  {
    const r = checkLocalProxyEligibility({
      env: {},
      supportsSpawn: true,
      vercelHosted: false,
    });
    pass("eligibility: flag off → refused",
      r.enabled === false && r.reason === "feature_flag_off");
  }
  {
    const r = checkLocalProxyEligibility({
      env: { [FEATURE_FLAG_NAME]: "1" },
      supportsSpawn: true,
      vercelHosted: true,
    });
    pass("eligibility: vercel hosted → refused",
      r.enabled === false && r.reason === "vercel_hosted");
  }
  {
    const r = checkLocalProxyEligibility({
      env: { [FEATURE_FLAG_NAME]: "1" },
      supportsSpawn: false,
      vercelHosted: false,
    });
    pass("eligibility: spawn unavailable → refused",
      r.enabled === false && r.reason === "spawn_unavailable");
  }
  {
    const r = checkLocalProxyEligibility({
      env: { [FEATURE_FLAG_NAME]: "1" },
      supportsSpawn: true,
      vercelHosted: false,
      config: { bindHost: "0.0.0.0" },
    });
    pass("eligibility: non-loopback bind without iUnderstand → refused",
      r.enabled === false && r.reason === "non_loopback_without_consent");
  }
  {
    const r = checkLocalProxyEligibility({
      env: { [FEATURE_FLAG_NAME]: "1" },
      supportsSpawn: true,
      vercelHosted: false,
      config: { bindHost: "0.0.0.0", iUnderstand: true },
    });
    pass("eligibility: non-loopback bind WITH iUnderstand → enabled",
      r.enabled === true && r.reason === undefined);
  }
  {
    const r = checkLocalProxyEligibility({
      env: { [FEATURE_FLAG_NAME]: "1" },
      supportsSpawn: true,
      vercelHosted: false,
    });
    pass("eligibility: defaults are eligible",
      r.enabled === true);
  }

  // ─── default config ───────────────────────────────────────────────
  pass("default bindHost is loopback",
    DEFAULT_LOCAL_PROXY_CONFIG.bindHost === "127.0.0.1");
  pass("default port is 9092",
    DEFAULT_LOCAL_PROXY_CONFIG.port === 9092);
  pass("default allowedOrigins is empty",
    DEFAULT_LOCAL_PROXY_CONFIG.allowedOrigins.length === 0);
  pass("provider mode constant exposed",
    LOCAL_PROXY_PROVIDER_MODE === "chatgptOAuthLocalProxy");

  // ─── PKCE + state ────────────────────────────────────────────────
  {
    const c = newOAuthChallenge();
    pass("challenge has codeVerifier (≥40 chars base64url)",
      typeof c.codeVerifier === "string" && c.codeVerifier.length >= 40 && /^[A-Za-z0-9_-]+$/.test(c.codeVerifier));
    pass("challenge has S256 codeChallenge (base64url)",
      typeof c.codeChallenge === "string" && /^[A-Za-z0-9_-]+$/.test(c.codeChallenge) && c.codeChallengeMethod === "S256");
    pass("challenge has random state",
      typeof c.state === "string" && c.state.length > 0);

    const c2 = newOAuthChallenge();
    pass("two challenges have distinct codeVerifiers",
      c.codeVerifier !== c2.codeVerifier);
    pass("two challenges have distinct states",
      c.state !== c2.state);

    pass("verifyOAuthState matches exact",
      verifyOAuthState(c.state, c.state) === true);
    pass("verifyOAuthState rejects mismatch",
      verifyOAuthState(c.state, c2.state) === false);
    pass("verifyOAuthState rejects length mismatch",
      verifyOAuthState(c.state, c.state.slice(1)) === false);
    pass("verifyOAuthState rejects non-strings",
      verifyOAuthState(c.state, undefined as any) === false);
  }

  // ─── in-memory vault ─────────────────────────────────────────────
  {
    const vault = createInMemoryVault();
    pass("vault initially empty",
      (await vault.read()) === null);
    const desc1 = await vault.describe();
    pass("describe reports empty",
      desc1.hasTokens === false);
    await vault.write({
      accessToken: "tok-aaa",
      refreshToken: "tok-rrr",
      expiresAt: Date.now() + 3600_000,
    });
    const r = await vault.read();
    pass("vault read returns written tokens",
      r?.accessToken === "tok-aaa" && r?.refreshToken === "tok-rrr");
    const desc2 = await vault.describe();
    pass("describe reports has-tokens=true with hint",
      desc2.hasTokens === true && /in-memory/.test(desc2.hint || ""));
    await vault.clear();
    pass("vault clear empties storage",
      (await vault.read()) === null);
  }

  if (failed > 0) {
    console.error(`\n${failed} local-proxy test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-local-proxy tests passed");
})();
