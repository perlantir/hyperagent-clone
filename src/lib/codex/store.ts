// P57 — Codex provider mode + bridge connection storage.
//
// Two pieces of state per user:
//   1. providerMode: "openaiApiKey" | "openaiUserApiKey" | "codexChatGPT"
//      Persisted as a plain column on users. Default: "openaiApiKey".
//   2. bridge connection details (URL + capability token) for the
//      codexChatGPT mode. Stored encrypted at rest using the same AES-GCM
//      helper that backs user_secrets, in a dedicated codex_bridges table
//      so it's never co-mingled with provider API keys.
//
// SECURITY:
//   - We never store ChatGPT auth tokens (accessToken / refreshToken /
//     idToken) in our DB. The bridge (codex app-server) owns its own
//     credential storage on the user's machine. We only know the bridge's
//     URL and capability token.
//   - Provider mode changes are explicit user actions — never silent.
//   - Disconnecting wipes the bridge row entirely.

import { pool } from "../db";
import { encryptValue, decryptValue } from "../secrets";
import {
  type CodexProviderMode,
  CODEX_PROVIDER_MODES,
  normalizeProviderMode,
  type CodexBridgeConfig,
} from "./types";

let _initialized = false;

export async function ensureCodexSchema() {
  if (_initialized) return;
  await pool().query(`
    -- Per-user provider mode. Default anthropicApiKey (the chat tool-loop
    -- has historically used Claude). Legacy rows may carry
    -- "openaiUserApiKey" — getProviderMode() normalizes those at read time.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS "codexProviderMode" TEXT NOT NULL DEFAULT 'anthropicApiKey';

    -- Codex bridge connection. URL + capability token, both encrypted.
    -- Single row per user keyed on userId. Disconnect = DELETE.
    CREATE TABLE IF NOT EXISTS codex_bridges (
      "userId" TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      "encryptedUrl" TEXT NOT NULL,
      "encryptedToken" TEXT NOT NULL,
      "experimentalApi" BOOLEAN NOT NULL DEFAULT FALSE,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    );
  `);
  _initialized = true;
}

// ─── provider mode ───────────────────────────────────────────────────

export async function getProviderMode(userId: string): Promise<CodexProviderMode> {
  await ensureCodexSchema();
  const r = await pool().query(
    `SELECT "codexProviderMode" AS mode FROM users WHERE id=$1`,
    [userId],
  );
  // normalizeProviderMode handles legacy values + unknown-mode safety.
  return normalizeProviderMode(r.rows[0]?.mode);
}

export async function setProviderMode(userId: string, mode: CodexProviderMode): Promise<void> {
  if (!CODEX_PROVIDER_MODES.includes(mode)) {
    throw new Error(`Unknown Codex provider mode: ${mode}`);
  }
  await ensureCodexSchema();
  await pool().query(
    `UPDATE users SET "codexProviderMode"=$1 WHERE id=$2`,
    [mode, userId],
  );
}

// ─── bridge config ───────────────────────────────────────────────────

export async function getBridgeConfig(userId: string): Promise<CodexBridgeConfig | null> {
  await ensureCodexSchema();
  const r = await pool().query(
    `SELECT "encryptedUrl", "encryptedToken", "experimentalApi" FROM codex_bridges WHERE "userId"=$1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  try {
    const url = decryptValue(row.encryptedUrl);
    const tok = decryptValue(row.encryptedToken);
    if (!url || !tok) return null;
    return {
      url,
      capabilityToken: tok,
      experimentalApi: !!row.experimentalApi,
    };
  } catch {
    // If decryption fails (e.g. ENCRYPTION_KEY rotation without re-encrypt),
    // surface as no-config rather than throwing through to the UI.
    return null;
  }
}

export async function setBridgeConfig(userId: string, cfg: CodexBridgeConfig): Promise<void> {
  await ensureCodexSchema();
  // Validate URL shape before persisting so we never store junk.
  let parsed: URL;
  try { parsed = new URL(cfg.url); }
  catch { throw new Error("Bridge URL is not a valid URL"); }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Bridge URL must use ws:// or wss://");
  }
  if (!cfg.capabilityToken || cfg.capabilityToken.length < 16) {
    throw new Error("Capability token must be at least 16 characters");
  }
  const now = Date.now();
  const encUrl = encryptValue(cfg.url);
  const encToken = encryptValue(cfg.capabilityToken);
  await pool().query(`
    INSERT INTO codex_bridges ("userId", "encryptedUrl", "encryptedToken", "experimentalApi", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $5)
    ON CONFLICT ("userId") DO UPDATE
      SET "encryptedUrl"=EXCLUDED."encryptedUrl",
          "encryptedToken"=EXCLUDED."encryptedToken",
          "experimentalApi"=EXCLUDED."experimentalApi",
          "updatedAt"=EXCLUDED."updatedAt"
  `, [userId, encUrl, encToken, !!cfg.experimentalApi, now]);
}

export async function deleteBridgeConfig(userId: string): Promise<void> {
  await ensureCodexSchema();
  await pool().query(`DELETE FROM codex_bridges WHERE "userId"=$1`, [userId]);
}
