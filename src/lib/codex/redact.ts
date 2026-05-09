// P57 — Codex redaction utility.
//
// SECURITY-CRITICAL. Never log, trace, or persist raw values for any of:
//   - accessToken, refreshToken, idToken
//   - Authorization headers
//   - PKCE code / verifier
//   - OAuth callback URLs
//   - app-server auth files
//   - account IDs (treated as PII)
//
// All app-server traffic is filtered through redactCodexMessage before it
// hits any logger / trace emitter / DB row.
//
// We redact rather than drop so debugging stays possible: tokens become
// "[REDACTED:accessToken]" (length-preserving feel, not the actual length).

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /id[_-]?token/i,
  /authorization/i,
  /bearer/i,
  /verifier/i,
  /^code$/i,
  /^pkce$/i,
  /code[_-]?verifier/i,
  /code[_-]?challenge/i,
  /callback[_-]?url/i,
  /redirect[_-]?uri/i,
  /api[_-]?key/i,
  /capability[_-]?token/i,
  /account[_-]?id/i,
  /^secret$/i,
  /client[_-]?secret/i,
  /^password$/i,
  /^token$/i,
];

// Heuristic: long base64-ish or sk-prefixed strings inside otherwise-
// innocuous fields are also tokens. Used as a defense-in-depth pass over
// string values when key-name redaction misses.
const VALUE_TOKEN_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /sk-(?:ant-|proj-|svc-)?[a-zA-Z0-9_-]{20,}/g, label: "[REDACTED:apiKey]" },
  { re: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, label: "[REDACTED:jwt]" },
  // OAuth `code=` query params
  { re: /([?&])code=[^&\s"']+/g, label: "$1code=[REDACTED:authCode]" },
  // OAuth `state=` query params (can leak account context)
  { re: /([?&])state=[^&\s"']+/g, label: "$1state=[REDACTED:state]" },
  // PKCE verifier in query
  { re: /([?&])code_verifier=[^&\s"']+/g, label: "$1code_verifier=[REDACTED:verifier]" },
  // Authorization header value, with or without preceding "Authorization:" key.
  // Two patterns so we catch both `authorization: Bearer xxx` and bare
  // `Bearer xxx` strings stored in arbitrary fields.
  { re: /(authorization:\s*bearer\s+)\S+/gi, label: "$1[REDACTED:bearer]" },
  { re: /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/g, label: "Bearer [REDACTED:bearer]" },
];

// Callback URLs (auth.openai.com, codex / chatgpt redirect) — redact the
// FULL URL string anywhere it appears so we never leak the host+path
// pair that uniquely identifies an in-flight login flow.
const CALLBACK_URL_PATTERNS: RegExp[] = [
  /https?:\/\/auth\.openai\.com\/[^\s"'<>]+/gi,
  /https?:\/\/auth\.chatgpt\.com\/[^\s"'<>]+/gi,
  /https?:\/\/[^/\s"'<>]+\/auth\/callback[^\s"'<>]*/gi,
  /https?:\/\/[^/\s"'<>]+\/oauth\/callback[^\s"'<>]*/gi,
  /https?:\/\/[^/\s"'<>]+\/codex\/callback[^\s"'<>]*/gi,
];

/**
 * Redact a free-form string. Idempotent — running twice is safe.
 * Public so call sites can sanitize ad-hoc strings before logging.
 */
export function redactString(input: string): string {
  if (!input) return input;
  let s = input;
  // 1. callback URLs first (the most identifying)
  for (const p of CALLBACK_URL_PATTERNS) s = s.replace(p, "[REDACTED:callbackUrl]");
  // 2. token-shaped values
  for (const { re, label } of VALUE_TOKEN_PATTERNS) s = s.replace(re, label);
  return s;
}

/**
 * Recursively redact a JSON value. Object keys matching SENSITIVE_KEY_PATTERNS
 * have their values replaced with "[REDACTED:<keyName>]"; nested objects /
 * arrays are walked. String leaves are passed through redactString. Other
 * primitives pass through unchanged.
 *
 * IMPORTANT: We intentionally do NOT mutate the input. Callers may still
 * use the original (non-redacted) value for the actual JSON-RPC call to
 * app-server; only the COPY that goes to traces/logs is redacted.
 */
export function redactJson<T>(value: T): T {
  return _walk(value) as T;
}

function _walk(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(_walk);
  if (typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      const sensitive = SENSITIVE_KEY_PATTERNS.some(p => p.test(k));
      if (sensitive) {
        // Preserve structure but blank the value. Use the key name as a hint.
        out[k] = `[REDACTED:${k}]`;
      } else {
        out[k] = _walk(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Redact a JSON-RPC envelope. Keeps the wire shape (jsonrpc / id /
 * method) but redacts params and result deeply. Use this before any
 * trace.emit("app_server_*", ...) or console.log of an envelope.
 */
export function redactRpcEnvelope(env: any): any {
  if (!env || typeof env !== "object") return env;
  const out: any = { jsonrpc: env.jsonrpc, id: env.id, method: env.method };
  if (env.params !== undefined) out.params = redactJson(env.params);
  if (env.result !== undefined) out.result = redactJson(env.result);
  if (env.error !== undefined) out.error = {
    code: env.error.code,
    message: typeof env.error.message === "string" ? redactString(env.error.message) : env.error.message,
    // error.data sometimes carries upstream tokens; redact it deeply.
    ...(env.error.data !== undefined ? { data: redactJson(env.error.data) } : {}),
  };
  return out;
}

/**
 * Convenience: redact a single Authorization header value.
 */
export function redactAuthHeader(value: string | null | undefined): string {
  if (!value) return "";
  if (/^bearer\s+/i.test(value)) return "Bearer [REDACTED:bearer]";
  if (/^basic\s+/i.test(value)) return "Basic [REDACTED:basic]";
  return "[REDACTED:authHeader]";
}
