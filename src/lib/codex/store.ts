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
  type CodexBridgeLocation,
} from "./types";
import {
  validateForServerSideFetch,
  validateForBrowserOrLocal,
  inferConnectionLocationFromUrl,
  validateTokenEntropy,
} from "./url-safety";

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
    -- P64.1 — declare WHERE the bridge is reachable from (browser /
    -- tunnel / local-server). Determines whether the hosted server is
    -- allowed to fetch the URL or whether the browser must drive the
    -- connection itself.
    ALTER TABLE codex_bridges ADD COLUMN IF NOT EXISTS "connectionLocation" TEXT NOT NULL DEFAULT 'browser';
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
    `SELECT "encryptedUrl", "encryptedToken", "experimentalApi", "connectionLocation" FROM codex_bridges WHERE "userId"=$1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  try {
    const url = decryptValue(row.encryptedUrl);
    const tok = decryptValue(row.encryptedToken);
    if (!url || !tok) return null;
    // Legacy rows (P57/P64) lack connectionLocation; infer from URL.
    let loc = (row.connectionLocation as CodexBridgeLocation) || undefined;
    if (!loc || (loc !== "browser" && loc !== "tunnel" && loc !== "local-server")) {
      const inferred = inferConnectionLocationFromUrl(url);
      // Conservative default: anything ambiguous becomes "browser" so
      // the server never blindly fetches it.
      loc = inferred === "tunnel" ? "tunnel" : "browser";
    }
    return {
      url,
      capabilityToken: tok,
      experimentalApi: !!row.experimentalApi,
      connectionLocation: loc,
    };
  } catch {
    return null;
  }
}

export async function setBridgeConfig(
  userId: string,
  cfg: CodexBridgeConfig,
): Promise<void> {
  await ensureCodexSchema();

  // P64.1 — connection location is required and drives validation.
  const loc: CodexBridgeLocation = cfg.connectionLocation || "browser";
  if (loc !== "browser" && loc !== "tunnel" && loc !== "local-server") {
    throw new Error(`Invalid connectionLocation: ${loc}`);
  }

  // Validate the URL against the right ruleset for this location.
  // - "browser"      → loopback/private OK; cloud metadata always blocked
  // - "tunnel"       → must be reachable from the public internet AND
  //                    pass the SSRF deny-list (no metadata, no leaking
  //                    a private IP through DNS rebinding via a name
  //                    that resolves to private space — but DNS check
  //                    runs at connection time, not write time)
  // - "local-server" → loopback/private allowed; the host is the same
  //                    machine where our Node runs. Refused on Vercel
  //                    at write time because there's no point.
  if (loc === "browser") {
    const r = validateForBrowserOrLocal(cfg.url);
    if (!r.ok) throw new Error(r.reason);
  } else if (loc === "tunnel") {
    const r = validateForServerSideFetch(cfg.url);
    if (!r.ok) throw new Error(r.reason);
  } else {
    // local-server
    if (process.env.VERCEL || process.env.VERCEL_ENV) {
      throw new Error("local-server connection mode is not available on hosted Vercel — pick browser or tunnel.");
    }
    const r = validateForBrowserOrLocal(cfg.url);
    if (!r.ok) throw new Error(r.reason);
  }

  // P64.2 — strengthened entropy gate. Capability token is matched by
  // SHA-256 on the bridge side; the only thing protecting the bridge is
  // raw token entropy, so we enforce a per-mode minimum:
  //   browser      ≥ 96 bits  (~24 hex chars)
  //   local-server ≥ 96 bits
  //   tunnel       ≥ 192 bits (~48 hex chars) — public internet exposure
  // The recommended setup uses 256-bit (64-hex) tokens; the in-app
  // generator now produces those by default.
  if (!cfg.capabilityToken) {
    throw new Error("Capability token is required");
  }
  const entropyCheck = validateTokenEntropy(cfg.capabilityToken, loc);
  if (!entropyCheck.ok) {
    throw new Error(entropyCheck.reason);
  }

  const now = Date.now();
  const encUrl = encryptValue(cfg.url);
  const encToken = encryptValue(cfg.capabilityToken);
  await pool().query(`
    INSERT INTO codex_bridges ("userId", "encryptedUrl", "encryptedToken", "experimentalApi", "connectionLocation", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $6)
    ON CONFLICT ("userId") DO UPDATE
      SET "encryptedUrl"=EXCLUDED."encryptedUrl",
          "encryptedToken"=EXCLUDED."encryptedToken",
          "experimentalApi"=EXCLUDED."experimentalApi",
          "connectionLocation"=EXCLUDED."connectionLocation",
          "updatedAt"=EXCLUDED."updatedAt"
  `, [userId, encUrl, encToken, !!cfg.experimentalApi, loc, now]);
}

export async function deleteBridgeConfig(userId: string): Promise<void> {
  await ensureCodexSchema();
  await pool().query(`DELETE FROM codex_bridges WHERE "userId"=$1`, [userId]);
}

// DEPRECATED in P64.1 — use classifyHost / validateForBrowserOrLocal /
// validateForServerSideFetch from ./url-safety.ts instead. Kept as a
// thin re-export for any third-party caller that imported it.
export function isLoopbackOrPrivate(host: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  // IPv4 loopback / RFC1918 / link-local
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const o1 = +ipv4[1], o2 = +ipv4[2];
    if (o1 === 127) return true;                           // loopback
    if (o1 === 10) return true;                            // 10.0.0.0/8
    if (o1 === 192 && o2 === 168) return true;             // 192.168.0.0/16
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;   // 172.16.0.0/12
    if (o1 === 169 && o2 === 254) return true;             // link-local
    return false;
  }
  // IPv6 unique-local fc00::/7 + link-local fe80::/10. Cheap prefix check.
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true;
  if (/^fe8[0-9a-f]:/.test(h)) return true;
  return false;
}
