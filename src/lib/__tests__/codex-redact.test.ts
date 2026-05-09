// P57 — codex redaction security tests.
//
// These test that we never leak the things the spec calls out as forbidden:
//   accessToken, refreshToken, idToken, Authorization, code, verifier,
//   callback URL, account ID, raw API keys.

import { redactString, redactJson, redactRpcEnvelope, redactAuthHeader } from "../codex/redact";

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) {
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  } else {
    console.log("PASS:", label);
  }
}

// Helper: assert the redacted output contains NO substring of the secret.
function assertNoLeak(label: string, output: string, secret: string) {
  pass(`${label} — secret absent`,
    !output.includes(secret),
    `secret '${secret.slice(0, 8)}...' leaked in output: ${output.slice(0, 120)}`);
}

// ─── string-level redaction ──────────────────────────────────────────

{
  const sk = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890";
  const out = redactString(`Got key=${sk} from caller`);
  assertNoLeak("OpenAI sk-proj key", out, sk);
  pass("OpenAI sk-proj key labeled", out.includes("[REDACTED:apiKey]"));
}

{
  const ant = "sk-ant-api03-very-long-anthropic-key-pretending-to-be-real-1234567890";
  const out = redactString(`Authorization: Bearer ${ant}`);
  assertNoLeak("Anthropic key", out, ant);
}

{
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_part_xxxxxxxxxx";
  const out = redactString(`{"id_token":"${jwt}"}`);
  assertNoLeak("JWT id_token", out, jwt);
  pass("JWT labeled", out.includes("[REDACTED:jwt]"));
}

{
  const code = "AQAAA-secret-oauth-code-xxxxx";
  const out = redactString(`https://app.example.com/auth/cb?code=${code}&state=abc`);
  assertNoLeak("OAuth code param", out, code);
  pass("OAuth state param redacted", out.includes("[REDACTED:state]"));
}

{
  const verifier = "MyPkceVerifier-12345-abcdefg";
  const out = redactString(`https://auth.openai.com/login?code_verifier=${verifier}`);
  assertNoLeak("PKCE code_verifier", out, verifier);
  // Whole callback URL should be redacted regardless.
  pass("Callback URL redacted", out.includes("[REDACTED:callbackUrl]"));
}

{
  const url = "https://auth.openai.com/oauth/authorize?client_id=foo&redirect_uri=bar";
  const out = redactString(`Open browser to ${url}`);
  assertNoLeak("auth.openai.com callback URL", out, "client_id=foo");
}

{
  const url = "https://app.example.com/auth/callback?code=secret123&state=xyz";
  const out = redactString(`Redirect: ${url}`);
  assertNoLeak("app /auth/callback URL", out, "secret123");
  assertNoLeak("app /auth/callback URL state", out, "xyz");
}

{
  const out = redactString(`authorization: Bearer abc.def.ghi`);
  assertNoLeak("authorization header", out, "abc.def.ghi");
}

// ─── JSON-level redaction ────────────────────────────────────────────

{
  const obj = {
    accessToken: "a1b2c3-super-secret",
    refreshToken: "r1r2r3-also-secret",
    idToken: "i1i2i3.jwt.parts.here",
    accountId: "acc_123456",
    nested: {
      Authorization: "Bearer xyz",
      callbackUrl: "https://app.example.com/auth/callback?code=abc",
    },
    safe: "hello world",
  };
  const r = redactJson(obj);

  pass("accessToken key replaced", r.accessToken === "[REDACTED:accessToken]");
  pass("refreshToken key replaced", r.refreshToken === "[REDACTED:refreshToken]");
  pass("idToken key replaced", r.idToken === "[REDACTED:idToken]");
  pass("accountId key replaced", r.accountId === "[REDACTED:accountId]");
  pass("nested Authorization key replaced",
    (r as any).nested.Authorization === "[REDACTED:Authorization]");
  pass("nested callbackUrl key replaced",
    (r as any).nested.callbackUrl === "[REDACTED:callbackUrl]");
  pass("safe value preserved", r.safe === "hello world");
}

{
  // Snake_case + alt casing should also match.
  const obj = {
    access_token: "secret-ish",
    code_verifier: "verifier-secret",
    code: "auth-code-secret",
    api_key: "sk-secret-456",
  };
  const r = redactJson(obj);
  pass("access_token snake matched", r.access_token === "[REDACTED:access_token]");
  pass("code_verifier snake matched", r.code_verifier === "[REDACTED:code_verifier]");
  pass("plain `code` key matched", r.code === "[REDACTED:code]");
  pass("api_key snake matched", r.api_key === "[REDACTED:api_key]");
}

{
  // Arrays + nested arrays should walk.
  const obj = {
    headers: [
      { name: "Authorization", value: "Bearer secret-1" },
      { name: "X-API-Key", value: "secret-2" },
    ],
  };
  const r = redactJson(obj);
  // The `value` keys themselves aren't sensitive by name, but the strings
  // inside a Bearer header should still be redacted by the string pass —
  // but the OUTER Authorization key on the object would match if the
  // header was at the object-key level. Here it's a value, so we expect
  // string-level redaction via the bearer pattern.
  const v0 = (r as any).headers[0].value;
  pass("Authorization header value bearer-redacted",
    v0.includes("[REDACTED:bearer]") && !v0.includes("secret-1"));
}

// ─── RPC envelope redaction ──────────────────────────────────────────

{
  const env = {
    jsonrpc: "2.0",
    id: 7,
    method: "account/login/start",
    params: { type: "chatgpt" },
    result: {
      loginUrl: "https://auth.openai.com/login?code=abc&verifier=xyz",
      accessToken: "should-never-be-here-but-just-in-case",
    },
  };
  const r = redactRpcEnvelope(env);
  pass("envelope keeps jsonrpc field", r.jsonrpc === "2.0");
  pass("envelope keeps method", r.method === "account/login/start");
  pass("envelope keeps id", r.id === 7);
  pass("envelope.result.loginUrl redacted",
    typeof r.result.loginUrl === "string" && !r.result.loginUrl.includes("auth.openai.com"));
  pass("envelope.result.accessToken redacted",
    r.result.accessToken === "[REDACTED:accessToken]");
}

{
  // Errors carrying upstream details often include tokens — must redact.data.
  const env = {
    jsonrpc: "2.0",
    id: 12,
    error: {
      code: -32603,
      message: "Authorization failed for token sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
      data: { Authorization: "Bearer abc.def.ghi", retryAfter: 30 },
    },
  };
  const r = redactRpcEnvelope(env);
  pass("error.message redacted",
    !r.error.message.includes("sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"));
  pass("error.data.Authorization redacted",
    r.error.data.Authorization === "[REDACTED:Authorization]");
  pass("error.data.retryAfter passthrough", r.error.data.retryAfter === 30);
}

// ─── auth header redaction ───────────────────────────────────────────

pass("redactAuthHeader Bearer", redactAuthHeader("Bearer mytoken123") === "Bearer [REDACTED:bearer]");
pass("redactAuthHeader Basic", redactAuthHeader("Basic dXNlcjpwYXNz") === "Basic [REDACTED:basic]");
pass("redactAuthHeader empty", redactAuthHeader("") === "");
pass("redactAuthHeader null", redactAuthHeader(null) === "");
pass("redactAuthHeader unknown", redactAuthHeader("Custom XYZ") === "[REDACTED:authHeader]");

// ─── idempotence ─────────────────────────────────────────────────────

{
  const once = redactString("Bearer sk-proj-mySecretKey1234567890");
  const twice = redactString(once);
  pass("redactString is idempotent", once === twice,
    `differ: \n  once=${once}\n  twice=${twice}`);
}

// ─── final ────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll redaction tests passed.");
