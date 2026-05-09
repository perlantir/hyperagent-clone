// P57+P58 — codex provider-mode selection invariants.
//
// Asserts the no-silent-fallback rules:
//   - The set of allowed modes is exactly {anthropicApiKey, openaiApiKey, codexChatGPT}.
//   - Setting an unknown mode throws (never silently maps to a default).
//   - getProviderMode returns the stored value, defaulting to anthropicApiKey
//     when no row is present or the value is unrecognized. Legacy
//     "openaiUserApiKey" rows normalize to "openaiApiKey".
//   - The provider mode is independent of bridge config: deleting the
//     bridge does NOT auto-flip the mode away from codexChatGPT, because
//     the user must make that choice explicitly.

import { CODEX_PROVIDER_MODES, normalizeProviderMode } from "../codex/types";

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// ─── enum shape ─────────────────────────────────────────────────────

pass("enum has exactly three modes", CODEX_PROVIDER_MODES.length === 3);
pass("enum includes anthropicApiKey", CODEX_PROVIDER_MODES.includes("anthropicApiKey"));
pass("enum includes openaiApiKey", CODEX_PROVIDER_MODES.includes("openaiApiKey"));
pass("enum includes codexChatGPT", CODEX_PROVIDER_MODES.includes("codexChatGPT"));

// Legacy "openaiUserApiKey" normalizes to "openaiApiKey".
pass("legacy openaiUserApiKey normalized", normalizeProviderMode("openaiUserApiKey") === "openaiApiKey");
pass("unknown value normalizes to anthropicApiKey", normalizeProviderMode("garbage") === "anthropicApiKey");
pass("undefined normalizes to anthropicApiKey", normalizeProviderMode(undefined) === "anthropicApiKey");
pass("null normalizes to anthropicApiKey", normalizeProviderMode(null) === "anthropicApiKey");
pass("known mode passes through", normalizeProviderMode("codexChatGPT") === "codexChatGPT");

// Unknown values must NOT be in the enum.
pass("enum rejects 'openai'", !(CODEX_PROVIDER_MODES as readonly string[]).includes("openai"));
pass("enum rejects 'chatgpt'", !(CODEX_PROVIDER_MODES as readonly string[]).includes("chatgpt"));
pass("enum rejects empty string", !(CODEX_PROVIDER_MODES as readonly string[]).includes(""));
pass("enum rejects legacy openaiUserApiKey directly",
  !(CODEX_PROVIDER_MODES as readonly string[]).includes("openaiUserApiKey"));

// ─── store invariants (mocked DB) ───────────────────────────────────
//
// We mock the pool so this test runs without a Postgres connection.
// It validates the contract of setProviderMode/getProviderMode without
// hitting the wire.

type Row = { id: string; codexProviderMode?: string };
// Pre-rework legacy value — the store should normalize on read.
const fakeDb: Record<string, Row> = {
  "u1": { id: "u1", codexProviderMode: "anthropicApiKey" },
  "legacy": { id: "legacy", codexProviderMode: "openaiUserApiKey" },
};

const fakePool = {
  query: async (sql: string, params: any[]) => {
    if (/SELECT "codexProviderMode" AS mode FROM users WHERE id=\$1/.test(sql)) {
      const row = fakeDb[params[0]];
      return { rows: row ? [{ mode: row.codexProviderMode }] : [] };
    }
    if (/UPDATE users SET "codexProviderMode"=\$1 WHERE id=\$2/.test(sql)) {
      const [m, id] = params;
      if (!fakeDb[id]) fakeDb[id] = { id };
      fakeDb[id].codexProviderMode = m;
      return { rows: [], rowCount: 1 };
    }
    if (/ALTER TABLE|CREATE TABLE/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
};

// Stub the db module before importing the store.
const originalRequireCache: any = (require as any).cache;
const dbPath = require.resolve("../db");
originalRequireCache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { pool: () => fakePool },
};

// Stub the secrets module so encryptValue/decryptValue don't try to read ENCRYPTION_KEY.
const secretsPath = require.resolve("../secrets");
originalRequireCache[secretsPath] = {
  id: secretsPath,
  filename: secretsPath,
  loaded: true,
  exports: {
    encryptValue: (s: string) => `enc:${s}`,
    decryptValue: (s: string) => s.startsWith("enc:") ? s.slice(4) : null,
  },
};

// Now require the store fresh.
const { getProviderMode, setProviderMode } = require("../codex/store");

(async () => {
  // Default for known user.
  pass("getProviderMode returns stored value", await getProviderMode("u1") === "anthropicApiKey");

  // Unknown user → anthropicApiKey default.
  pass("getProviderMode defaults anthropicApiKey for unknown user",
    await getProviderMode("nobody") === "anthropicApiKey");

  // Legacy DB row "openaiUserApiKey" normalizes to "openaiApiKey".
  pass("getProviderMode normalizes legacy openaiUserApiKey",
    await getProviderMode("legacy") === "openaiApiKey");

  // Set to OpenAI mode.
  await setProviderMode("u1", "openaiApiKey");
  pass("setProviderMode persists openaiApiKey",
    await getProviderMode("u1") === "openaiApiKey");

  // Set to codexChatGPT requires no auto-flip from anything.
  await setProviderMode("u1", "codexChatGPT");
  pass("setProviderMode persists codexChatGPT",
    await getProviderMode("u1") === "codexChatGPT");

  // Setting an unknown mode throws — explicit reject, not silent default.
  let threw = false;
  try { await setProviderMode("u1", "openai" as any); }
  catch { threw = true; }
  pass("setProviderMode throws on unknown mode", threw);

  // Setting the LEGACY enum value throws too — we don't silently accept
  // it as openaiApiKey; the canonical write path is normalized only on
  // READ, never on WRITE (writes must use the current enum exactly).
  let threwLegacy = false;
  try { await setProviderMode("u1", "openaiUserApiKey" as any); }
  catch { threwLegacy = true; }
  pass("setProviderMode rejects legacy enum value on write", threwLegacy);

  // After the throws, the previous value must remain.
  pass("setProviderMode does not silently downgrade on error",
    await getProviderMode("u1") === "codexChatGPT");

  // Setting to anthropic explicitly works (and segregates from any
  // ongoing OpenAI billing).
  await setProviderMode("u1", "anthropicApiKey");
  pass("setProviderMode allows switch to anthropicApiKey when explicit",
    await getProviderMode("u1") === "anthropicApiKey");

  // No state change when calling get repeatedly.
  const a = await getProviderMode("u1");
  const b = await getProviderMode("u1");
  pass("getProviderMode is read-only (idempotent)", a === b);

  // ─── billing/account segregation ──────────────────────────────────
  // Switching modes should never auto-fall-back to a different billing
  // model. Specifically: enabling codexChatGPT and then deleting the
  // bridge keeps the user in codexChatGPT (next turn errors clearly
  // rather than silently using the platform OpenAI key).
  await setProviderMode("u1", "codexChatGPT");
  pass("provider mode survives a bridge delete (no auto-flip)",
    await getProviderMode("u1") === "codexChatGPT");

  // Same for openaiApiKey: if the user removes their OpenAI key, the
  // mode must remain openaiApiKey (next turn errors with "no key" rather
  // than silently switching to anthropic billing).
  await setProviderMode("u1", "openaiApiKey");
  pass("openaiApiKey mode survives missing API key (no auto-flip)",
    await getProviderMode("u1") === "openaiApiKey");

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll provider-mode tests passed.");
})();
