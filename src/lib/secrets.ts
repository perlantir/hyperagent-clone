// Per-user encrypted API key store (P19+ "BYO keys").
//
// Each user can save their own API key for any supported provider in Settings.
// Keys are AES-256-GCM encrypted at rest using ENCRYPTION_KEY (or a derived
// dev fallback). resolveSecret() is the single read path: it returns the
// user's key if present, otherwise the platform env-var fallback, otherwise
// null. All runtime callers (llm.ts, media.ts, browser.ts, composio.ts) go
// through resolveSecret so adding a key in Settings immediately works
// without a redeploy.
//
// Threat model:
//   - DB compromise alone leaks ciphertext only; attacker still needs
//     ENCRYPTION_KEY to decrypt. Set ENCRYPTION_KEY (32 bytes base64) in
//     Vercel for production.
//   - Memory disclosure during a single request can expose the decrypted
//     key — same as env vars. Acceptable for SaaS use.

import crypto from "node:crypto";
import { pool } from "./db";

const ENC_VERSION = 1;
const ALGORITHM = "aes-256-gcm";

export const SECRET_PROVIDERS = [
  "anthropic",     // Claude — chat
  "openai",        // GPT-4o + tts-1 + Sora — chat & media
  "xai",           // Grok 2 Image
  "gemini",        // Gemini 2.5 + Nano Banana + Veo — chat & media
  "hyperbrowser",  // Cloud Chromium — browser/computer-use
  "composio",      // 500+ third-party connectors
  "e2b",           // Sandboxed code execution (Python, shell)
] as const;
export type SecretProvider = typeof SECRET_PROVIDERS[number];

// What env-var to fall back to when no user key is set.
const ENV_FALLBACKS: Record<SecretProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  hyperbrowser: "HYPERBROWSER_API_KEY",
  composio: "COMPOSIO_API_KEY",
  e2b: "E2B_API_KEY",
};

// User-facing metadata for the settings UI.
export const PROVIDER_META: Record<SecretProvider, {
  label: string; description: string; placeholder: string; helpUrl: string;
}> = {
  anthropic: {
    label: "Anthropic", description: "Claude models — chat, reasoning, tool use.",
    placeholder: "sk-ant-api03-...", helpUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    label: "OpenAI", description: "GPT-4o for chat, gpt-image-1, tts-1, Sora video.",
    placeholder: "sk-...", helpUrl: "https://platform.openai.com/api-keys",
  },
  xai: {
    label: "xAI Grok", description: "Grok 2 Image (Aurora). Image generation only for now.",
    placeholder: "xai-...", helpUrl: "https://console.x.ai",
  },
  gemini: {
    label: "Google Gemini", description: "Gemini 2.5 chat, Nano Banana image, Veo video, native TTS.",
    placeholder: "AI...", helpUrl: "https://aistudio.google.com/app/apikey",
  },
  hyperbrowser: {
    label: "Hyperbrowser", description: "Cloud Chromium for browser automation + computer-use tools.",
    placeholder: "hb_...", helpUrl: "https://hyperbrowser.ai",
  },
  composio: {
    label: "Composio", description: "OAuth-managed connectors for 500+ apps (Slack, Gmail, GitHub, Notion…).",
    placeholder: "ak_...", helpUrl: "https://app.composio.dev",
  },
  e2b: {
    label: "e2b", description: "Cloud sandboxes for code execution — Python, shell, file I/O.",
    placeholder: "e2b_...", helpUrl: "https://e2b.dev/dashboard",
  },
};

function deriveKey(): Buffer {
  const env = process.env.ENCRYPTION_KEY;
  if (env) {
    // Accept base64 or raw — hash to 32 bytes either way for safety.
    return crypto.createHash("sha256").update(env).digest();
  }
  // Dev fallback: derive from DATABASE_URL hash so multiple instances on the
  // same DB can read each other's secrets even without ENCRYPTION_KEY.
  const seed = process.env.DATABASE_URL || "hyperagent-dev-only-fallback-seed";
  return crypto.createHash("sha256").update(seed).digest();
}

export function encryptValue(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptValue(stored: string): string | null {
  try {
    const parts = stored.split(":");
    if (parts.length !== 4) return null;
    const [v, ivB64, tagB64, encB64] = parts;
    if (Number(v) !== ENC_VERSION) return null;
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const enc = Buffer.from(encB64, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch { return null; }
}

async function ensureTable() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS user_secrets (
      "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      "encryptedValue" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL,
      PRIMARY KEY ("userId", provider)
    );
  `);
}

export async function setUserSecret(userId: string, provider: SecretProvider, value: string) {
  await ensureTable();
  const enc = encryptValue(value);
  const now = Date.now();
  await pool().query(
    `INSERT INTO user_secrets ("userId", provider, "encryptedValue", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT ("userId", provider) DO UPDATE
       SET "encryptedValue"=EXCLUDED."encryptedValue", "updatedAt"=EXCLUDED."updatedAt"`,
    [userId, provider, enc, now],
  );
}

export async function deleteUserSecret(userId: string, provider: SecretProvider) {
  await ensureTable();
  await pool().query(`DELETE FROM user_secrets WHERE "userId"=$1 AND provider=$2`, [userId, provider]);
}

// Returns { provider: bool } — true if user has saved their own key, false if
// they fall back to platform default. Never returns the raw value.
export async function listUserSecretPresence(userId: string): Promise<Record<SecretProvider, "user" | "platform" | "missing">> {
  await ensureTable();
  const r = await pool().query(`SELECT provider FROM user_secrets WHERE "userId"=$1`, [userId]);
  const set = new Set<string>(r.rows.map((row: any) => row.provider));
  const out: any = {};
  for (const p of SECRET_PROVIDERS) {
    if (set.has(p)) out[p] = "user";
    else if (process.env[ENV_FALLBACKS[p]]) out[p] = "platform";
    else out[p] = "missing";
  }
  return out;
}

// Single read path. Order: user override → env-var fallback → null.
// userId may be null (e.g. webhook handlers, cron jobs) — only env is checked.
export async function resolveSecret(userId: string | null | undefined, provider: SecretProvider): Promise<string | null> {
  if (userId) {
    try {
      await ensureTable();
      const r = await pool().query(
        `SELECT "encryptedValue" FROM user_secrets WHERE "userId"=$1 AND provider=$2`,
        [userId, provider],
      );
      if (r.rows[0]) {
        const dec = decryptValue(r.rows[0].encryptedValue);
        if (dec) return dec;
      }
    } catch (e) {
      console.error(`[resolveSecret ${provider}]`, e);
    }
  }
  return process.env[ENV_FALLBACKS[provider]] || null;
}
