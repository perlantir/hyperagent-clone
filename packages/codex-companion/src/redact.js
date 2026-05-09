// Lightweight redactor mirrored from the hosted app's redact.ts so the
// companion never logs secrets locally. We keep a small allowlist of
// known sensitive fields plus a string-shaped scanner for tokens.

const SENSITIVE_KEYS = new Set([
  "authorization",
  "Authorization",
  "accessToken",
  "refreshToken",
  "idToken",
  "id_token",
  "access_token",
  "refresh_token",
  "apiKey",
  "api_key",
  "capabilityToken",
  "capability_token",
  "sessionSecret",
  "session_secret",
  "pairCode",
  "pair_code",
  "secret",
  "password",
  "Authorization-Bearer",
]);

function redact(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return redactString(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const k of Object.keys(value)) {
    if (SENSITIVE_KEYS.has(k) || /token|secret|password/i.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redact(value[k]);
    }
  }
  return out;
}

function redactString(s) {
  if (typeof s !== "string") return s;
  // Strip Bearer headers + obvious-looking tokens.
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-=]{8,}/g, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_\-]{16,}/g, "sk-[REDACTED]")
    .replace(/(eyJ[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]+)/g, "[JWT_REDACTED]");
}

module.exports = { redact, redactString };
