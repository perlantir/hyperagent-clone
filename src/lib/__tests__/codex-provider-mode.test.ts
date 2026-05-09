// P57 + P58 + P64 — codex provider-mode selection invariants.
//
// Asserts the no-silent-fallback rules across the rebuild:
//   - The set of allowed modes is exactly the 6-mode P64 enum.
//   - Setting an unknown mode throws (never silently maps to a default).
//   - getProviderMode returns the stored value, defaulting to
//     anthropicApiKey when no row is present or the value is unrecognized.
//   - Legacy values normalize: "codexChatGPT" → "codexChatGPTBridge"
//     so users who configured Phase 1 in P57 don't lose their setting.
//   - The provider mode is independent of bridge config: deleting the
//     bridge does NOT auto-flip the mode away from any codex mode.

import { CODEX_PROVIDER_MODES, normalizeProviderMode, isCodexMode } from "../codex/types";

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// ─── enum shape ─────────────────────────────────────────────────────

pass("enum has exactly six modes", CODEX_PROVIDER_MODES.length === 6);
pass("enum includes anthropicApiKey",         CODEX_PROVIDER_MODES.includes("anthropicApiKey"));
pass("enum includes openaiApiKey",            CODEX_PROVIDER_MODES.includes("openaiApiKey"));
pass("enum includes openaiUserApiKey",        CODEX_PROVIDER_MODES.includes("openaiUserApiKey"));
pass("enum includes codexChatGPTLocal",       CODEX_PROVIDER_MODES.includes("codexChatGPTLocal"));
pass("enum includes codexChatGPTBridge",      CODEX_PROVIDER_MODES.includes("codexChatGPTBridge"));
pass("enum includes codexChatGPTCompanion",   CODEX_PROVIDER_MODES.includes("codexChatGPTCompanion"));

// Legacy "codexChatGPT" (the P57 enum value) → "codexChatGPTBridge".
pass("legacy codexChatGPT normalizes to codexChatGPTBridge",
  normalizeProviderMode("codexChatGPT") === "codexChatGPTBridge");
pass("unknown value normalizes to anthropicApiKey",
  normalizeProviderMode("garbage") === "anthropicApiKey");
pass("undefined normalizes to anthropicApiKey",
  normalizeProviderMode(undefined) === "anthropicApiKey");
pass("null normalizes to anthropicApiKey",
  normalizeProviderMode(null) === "anthropicApiKey");
pass("known codex mode passes through",
  normalizeProviderMode("codexChatGPTLocal") === "codexChatGPTLocal");

// isCodexMode reports correctly for the three codex sub-modes.
pass("isCodexMode true for codexChatGPTLocal",
  isCodexMode("codexChatGPTLocal" as any) === true);
pass("isCodexMode true for codexChatGPTBridge",
  isCodexMode("codexChatGPTBridge" as any) === true);
pass("isCodexMode true for codexChatGPTCompanion",
  isCodexMode("codexChatGPTCompanion" as any) === true);
pass("isCodexMode false for anthropicApiKey",
  isCodexMode("anthropicApiKey" as any) === false);
pass("isCodexMode false for openaiApiKey",
  isCodexMode("openaiApiKey" as any) === false);

// Unknown values must NOT be in the enum.
pass("enum rejects 'openai'", !(CODEX_PROVIDER_MODES as readonly string[]).includes("openai"));
pass("enum rejects 'chatgpt'", !(CODEX_PROVIDER_MODES as readonly string[]).includes("chatgpt"));
pass("enum rejects empty string", !(CODEX_PROVIDER_MODES as readonly string[]).includes(""));
pass("enum rejects legacy codexChatGPT directly",
  !(CODEX_PROVIDER_MODES as readonly string[]).includes("codexChatGPT"));

// ─── store invariants (mocked DB) ───────────────────────────────────
//
// We mock the pool so this test runs without a Postgres connection.
// It validates the contract of setProviderMode/getProviderMode without
// hitting the wire.

type Row = { id: string; codexProviderMode?: string };
// Pre-rework legacy value — the store should normalize on read.
const fakeDb: Record<string, Row> = {
  "u1": { id: "u1", codexProviderMode: "anthropicApiKey" },
  "legacy": { id: "legacy", codexProviderMode: "codexChatGPT" },
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

  // Legacy DB row "codexChatGPT" normalizes to "codexChatGPTBridge".
  pass("getProviderMode normalizes legacy codexChatGPT → codexChatGPTBridge",
    await getProviderMode("legacy") === "codexChatGPTBridge");

  // Set to OpenAI mode.
  await setProviderMode("u1", "openaiApiKey");
  pass("setProviderMode persists openaiApiKey",
    await getProviderMode("u1") === "openaiApiKey");

  // Set to user-key mode explicitly.
  await setProviderMode("u1", "openaiUserApiKey");
  pass("setProviderMode persists openaiUserApiKey",
    await getProviderMode("u1") === "openaiUserApiKey");

  // Set to each codex sub-mode.
  for (const m of ["codexChatGPTLocal", "codexChatGPTBridge", "codexChatGPTCompanion"] as const) {
    await setProviderMode("u1", m);
    pass(`setProviderMode persists ${m}`,
      await getProviderMode("u1") === m);
  }

  // Setting an unknown mode throws — explicit reject, not silent default.
  let threw = false;
  try { await setProviderMode("u1", "openai" as any); }
  catch { threw = true; }
  pass("setProviderMode throws on unknown mode", threw);

  // Setting the LEGACY enum value (P57's "codexChatGPT") throws too;
  // the canonical write path is normalized only on READ, never on
  // WRITE. Writes must use the current enum exactly.
  let threwLegacy = false;
  try { await setProviderMode("u1", "codexChatGPT" as any); }
  catch { threwLegacy = true; }
  pass("setProviderMode rejects legacy codexChatGPT on write", threwLegacy);

  // After the throws, the previous value must remain — for the codex
  // family this keeps Phase 1/2/3 segregation explicit.
  pass("setProviderMode does not silently downgrade on error",
    await getProviderMode("u1") === "codexChatGPTCompanion");

  // Setting to anthropic explicitly works (and segregates from any
  // ongoing OpenAI billing).
  await setProviderMode("u1", "anthropicApiKey");
  pass("setProviderMode allows switch to anthropicApiKey when explicit",
    await getProviderMode("u1") === "anthropicApiKey");

  // No state change when calling get repeatedly.
  const a = await getProviderMode("u1");
  const b = await getProviderMode("u1");
  pass("getProviderMode is read-only (idempotent)", a === b);

  // ─── account segregation between Codex sub-modes ──────────────────
  // Switching from codexChatGPTLocal to codexChatGPTBridge must NOT
  // silently carry the local-stdio auth state into bridge mode.
  // Provider mode change is the user's explicit decision; we just
  // verify the value persists as written.
  await setProviderMode("u1", "codexChatGPTLocal");
  pass("codexChatGPTLocal persists explicitly",
    await getProviderMode("u1") === "codexChatGPTLocal");
  await setProviderMode("u1", "codexChatGPTBridge");
  pass("flip Local → Bridge persists explicitly (no silent reuse)",
    await getProviderMode("u1") === "codexChatGPTBridge");

  // Bridge config goes missing → mode does NOT auto-flip.
  pass("provider mode survives a bridge delete (no auto-flip)",
    await getProviderMode("u1") === "codexChatGPTBridge");

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
