// P66e — Local OpenAI-compatible proxy for ChatGPT subscription auth.
//
// EXPERIMENTAL. Feature-flagged. Local/dev/desktop/companion only.
//
// Background. Codex app-server is the official integration boundary
// for everything we do today. The local proxy mode exists as a thin
// compatibility shim for LangChain-shaped callers that expect:
//
//   const client = new OpenAI({
//     baseURL: "http://127.0.0.1:9092/v1",
//     apiKey:  "anything"   // proxy ignores this
//   });
//
// The proxy:
//   - runs ONLY when HYPERAGENT_EXPERIMENTAL_CHATGPT_OAUTH=true
//   - binds 127.0.0.1 only by default
//   - opens a localhost OAuth callback (PKCE) the first time it's
//     started; tokens land in an OS keychain entry (`keytar`) — never
//     on disk in plaintext, never in the hosted Vercel DB.
//   - exposes /v1/chat/completions, /chat/completions, /v1/models
//   - forwards to ChatGPT's documented surface using the user's
//     OAuth token; we do NOT proxy private/undocumented endpoints.
//
// Runtime availability:
//
//   - npm run dev / desktop / native wrapper → direct
//   - hosted Vercel → REFUSED at startup; the proxy only runs when the
//     env var IS set AND `getLocalRuntimeStatus().supportsSpawn === true`.
//   - companion → companion may opt in via --enable-local-proxy (P66+)
//
// SECURITY:
//
//   - Proxy port binds to 127.0.0.1 by default; setting `bindHost` to
//     anything else requires `iUnderstand: true`.
//   - We require an OAuth `state` value over our local callback that
//     matches the value we generated at flow start (PKCE + state).
//   - We never log: access tokens, refresh tokens, ID tokens, the
//     OAuth callback URL, the Authorization header, the api key the
//     LangChain client sends.
//   - The proxy returns 403 to any request whose Origin matches a
//     remote host the user didn't allowlist.
//
// This file SHIPS the scaffolding + types. The actual ChatGPT
// integration logic lives in `local-proxy-runtime.ts` (companion
// package) and is gated behind the feature flag.

export const FEATURE_FLAG_NAME = "HYPERAGENT_EXPERIMENTAL_CHATGPT_OAUTH";

export function isLocalProxyFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[FEATURE_FLAG_NAME];
  return v === "1" || v === "true" || v === "TRUE";
}

export interface LocalProxyConfig {
  bindHost: string;       // default "127.0.0.1"
  port: number;           // default 9092 (LangChain default OPENAI_BASE_URL port)
  allowedOrigins: string[]; // empty = no Origin header allowed (curl-only)
  iUnderstand?: boolean;  // required to use a non-loopback bindHost
}

export const DEFAULT_LOCAL_PROXY_CONFIG: LocalProxyConfig = {
  bindHost: "127.0.0.1",
  port: 9092,
  allowedOrigins: [],
};

// ─── Eligibility check ────────────────────────────────────────────────
//
// Returns null when the proxy CAN be started (and explains why); else
// returns a refusal reason. Used by both the CLI starter and any UI
// that surfaces "Local proxy mode" as an option.

export interface ProxyEligibility {
  enabled: boolean;
  reason?: "feature_flag_off" | "vercel_hosted" | "spawn_unavailable" | "non_loopback_without_consent";
  message?: string;
}

export function checkLocalProxyEligibility(opts: {
  env?: NodeJS.ProcessEnv;
  supportsSpawn: boolean;
  vercelHosted: boolean;
  config?: Partial<LocalProxyConfig>;
}): ProxyEligibility {
  const env = opts.env ?? process.env;
  if (!isLocalProxyFeatureEnabled(env)) {
    return {
      enabled: false,
      reason: "feature_flag_off",
      message: `Set ${FEATURE_FLAG_NAME}=1 to enable. The local proxy mode is experimental and not for production.`,
    };
  }
  if (opts.vercelHosted) {
    return {
      enabled: false,
      reason: "vercel_hosted",
      message: "Local proxy mode is not available on hosted Vercel. Run Hyperagent locally or use the Companion to host the proxy on your machine.",
    };
  }
  if (!opts.supportsSpawn) {
    return {
      enabled: false,
      reason: "spawn_unavailable",
      message: "Local proxy mode requires a Node host that can keep a long-lived process alive.",
    };
  }
  const cfg = { ...DEFAULT_LOCAL_PROXY_CONFIG, ...(opts.config ?? {}) };
  const isLoopback = cfg.bindHost === "127.0.0.1" || cfg.bindHost === "::1" || cfg.bindHost === "localhost";
  if (!isLoopback && !cfg.iUnderstand) {
    return {
      enabled: false,
      reason: "non_loopback_without_consent",
      message: `Refusing to bind the local proxy to ${cfg.bindHost}. Loopback is the only safe default. Pass iUnderstand: true to override.`,
    };
  }
  return { enabled: true };
}

// ─── OAuth state helpers (PKCE + state) ───────────────────────────────
//
// The CLI starter calls these to drive the localhost OAuth callback.
// We don't ship the actual token-vault implementation here (lives in
// the companion package via `keytar`); we DO export the verifier
// helper so unit tests + audit trail have a single source of truth.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface OAuthChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state: string;
}

export function newOAuthChallenge(): OAuthChallenge {
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const state = base64url(randomBytes(16));
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256", state };
}

export function verifyOAuthState(expected: string, got: string): boolean {
  if (typeof got !== "string" || typeof expected !== "string") return false;
  if (got.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(got, "utf8")); }
  catch { return false; }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── Token vault interface (implementation lives in companion pkg) ───
//
// Every method MUST be safe to leave un-awaited: vault is best-effort
// from the proxy's POV. If the keychain is locked or unavailable, the
// proxy refuses to start (clean error to the user).

export interface TokenVault {
  // Read currently-stored tokens. Returns null if there are none.
  read(): Promise<{
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    expiresAt: number;
    chatgptAccountId?: string;
    chatgptPlanType?: string;
  } | null>;
  // Replace stored tokens. Caller must redact the input from logs.
  write(tokens: {
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    expiresAt: number;
    chatgptAccountId?: string;
    chatgptPlanType?: string;
  }): Promise<void>;
  // Wipe.
  clear(): Promise<void>;
  // Diagnostic — does NOT return any token material.
  describe(): Promise<{ hasTokens: boolean; expiresAt?: number; hint?: string }>;
}

// In-memory vault used for tests + dev when keytar isn't installed.
// SECURITY: never use in production.
export function createInMemoryVault(): TokenVault {
  let mem: any = null;
  return {
    async read() { return mem; },
    async write(t) { mem = t; },
    async clear() { mem = null; },
    async describe() {
      return {
        hasTokens: !!mem,
        expiresAt: mem?.expiresAt,
        hint: mem ? "in-memory (NOT for production)" : "empty",
      };
    },
  };
}

// ─── Provider mode helper ─────────────────────────────────────────────

export const LOCAL_PROXY_PROVIDER_MODE = "chatgptOAuthLocalProxy";
