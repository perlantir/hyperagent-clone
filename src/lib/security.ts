// P33a — Webhook signature verification + secret redaction + PII detection.
//
// One helper for every inbound webhook so we don't copy-paste HMAC logic into
// every route. Adding a new provider is a one-line case in verifyWebhookSignature.
//
// Secret redaction is applied to trace event payloads + log lines so we
// don't leak user keys (their own or others') into our logs/storage.
//
// PII detection is naive (regex-based) for v0; suitable for "should this
// memory be flagged for review?" but not for compliance-grade scrubbing.

import crypto from "node:crypto";

// =================== WEBHOOK SIGNATURE ===================

export type WebhookProvider = "stripe" | "slack" | "github" | "generic_hmac_sha256";

export interface SignatureResult {
  valid: boolean;
  reason?: string;
}

export function verifyWebhookSignature(
  provider: WebhookProvider,
  body: string,
  headers: Headers,
  secret: string,
): SignatureResult {
  if (!secret) return { valid: false, reason: "no secret configured" };

  switch (provider) {
    case "stripe": return verifyStripe(body, headers, secret);
    case "slack":  return verifySlack(body, headers, secret);
    case "github": return verifyGithub(body, headers, secret);
    case "generic_hmac_sha256": return verifyGenericHmac(body, headers, secret);
    default: return { valid: false, reason: `unknown provider: ${provider}` };
  }
}

function verifyStripe(body: string, headers: Headers, secret: string): SignatureResult {
  const sigHeader = headers.get("stripe-signature");
  if (!sigHeader) return { valid: false, reason: "missing stripe-signature" };
  const parts = Object.fromEntries(sigHeader.split(",").map(p => p.split("=")));
  const ts = parts.t; const v1 = parts.v1;
  if (!ts || !v1) return { valid: false, reason: "malformed stripe-signature" };
  // Stripe also sets a 5-minute tolerance; reject older
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { valid: false, reason: "timestamp too old" };
  const computed = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return safeEq(computed, v1) ? { valid: true } : { valid: false, reason: "signature mismatch" };
}

function verifySlack(body: string, headers: Headers, secret: string): SignatureResult {
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature");
  if (!ts || !sig) return { valid: false, reason: "missing slack signature headers" };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { valid: false, reason: "timestamp too old" };
  const base = `v0:${ts}:${body}`;
  const mac = crypto.createHmac("sha256", secret).update(base).digest("hex");
  const computed = `v0=${mac}`;
  return safeEq(computed, sig) ? { valid: true } : { valid: false, reason: "signature mismatch" };
}

function verifyGithub(body: string, headers: Headers, secret: string): SignatureResult {
  const sig = headers.get("x-hub-signature-256");
  if (!sig) return { valid: false, reason: "missing x-hub-signature-256" };
  const computed = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return safeEq(computed, sig) ? { valid: true } : { valid: false, reason: "signature mismatch" };
}

function verifyGenericHmac(body: string, headers: Headers, secret: string): SignatureResult {
  // Looks for "x-signature" header with hex HMAC-SHA256 of the body.
  const sig = headers.get("x-signature");
  if (!sig) return { valid: false, reason: "missing x-signature" };
  const computed = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return safeEq(computed, sig) ? { valid: true } : { valid: false, reason: "signature mismatch" };
}

function safeEq(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch { return false; }
}

// =================== SECRET REDACTION ===================

// Patterns matching common API key/token formats. Add new ones as we wire
// new providers. The goal is "log-safe" — never paste these into traces or
// stdout, even if the user includes them in chat.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "anthropic", re: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
  { name: "openai",    re: /sk-(?:proj-)?[a-zA-Z0-9_-]{20,}/g },
  { name: "xai",       re: /xai-[a-zA-Z0-9_-]{20,}/g },
  { name: "gemini",    re: /AIza[a-zA-Z0-9_-]{30,}/g },
  { name: "stripe_secret",  re: /sk_(?:test_|live_)[a-zA-Z0-9]{20,}/g },
  { name: "stripe_pub",     re: /pk_(?:test_|live_)[a-zA-Z0-9]{20,}/g },
  { name: "stripe_webhook", re: /whsec_[a-zA-Z0-9_-]{20,}/g },
  { name: "slack_bot",      re: /xoxb-[a-zA-Z0-9-]{20,}/g },
  { name: "slack_user",     re: /xoxp-[a-zA-Z0-9-]{20,}/g },
  { name: "github",         re: /gh[pousr]_[a-zA-Z0-9]{30,}/g },
  { name: "hyperbrowser",   re: /hb_[a-zA-Z0-9]{20,}/g },
  { name: "e2b",            re: /e2b_[a-zA-Z0-9]{20,}/g },
  { name: "composio",       re: /\bak_[a-zA-Z0-9_-]{20,}/g },
  { name: "liveblocks_pk",  re: /pk_(?:dev|prod)_[a-zA-Z0-9_-]{30,}/g },
  { name: "liveblocks_sk",  re: /sk_(?:dev|prod)_[a-zA-Z0-9_-]{30,}/g },
  { name: "hyperagent_api", re: /hak_[a-zA-Z0-9_-]{20,}/g },
  { name: "aws_access",     re: /AKIA[0-9A-Z]{16}/g },
  { name: "jwt",            re: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
];

// Replace any matching secret with [REDACTED:provider]. Idempotent — running
// twice doesn't double-redact.
export function redactSecrets(input: string): string {
  let s = input;
  for (const p of SECRET_PATTERNS) {
    s = s.replace(p.re, `[REDACTED:${p.name}]`);
  }
  return s;
}

// Recursively redact secrets in any JSON-serializable value. Used by the
// trace emitter before INSERT.
export function redactSecretsDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSecrets(value) as any;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(redactSecretsDeep) as any;
  if (typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecretsDeep(v);
    }
    return out;
  }
  return value;
}

// =================== PII DETECTION ===================

const PII_PATTERNS: Array<{ type: string; re: RegExp }> = [
  { type: "email", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { type: "phone_us", re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: "credit_card", re: /\b(?:\d[ -]?){13,16}\b/g },
  { type: "ip_v4", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

export interface PiiDetection {
  hasPii: boolean;
  types: string[];
  count: number;
}

export function detectPii(input: string): PiiDetection {
  const types: string[] = [];
  let count = 0;
  for (const p of PII_PATTERNS) {
    const matches = input.match(p.re);
    if (matches?.length) {
      types.push(p.type);
      count += matches.length;
    }
  }
  return { hasPii: types.length > 0, types, count };
}
