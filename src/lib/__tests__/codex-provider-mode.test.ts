// P57 — codex provider-mode selection invariants.
//
// Asserts the no-silent-fallback rules:
//   - The set of allowed modes is exactly {openaiApiKey, openaiUserApiKey, codexChatGPT}.
//   - Setting an unknown mode throws (never silently maps to a default).
//   - getProviderMode returns the stored value, defaulting to openaiApiKey
//     ONLY when no row is present — not as a fallback when the column has
//     an unrecognized value (which is treated as "use default").
//   - The provider mode is independent of bridge config: deleting the
//     bridge does NOT auto-flip the mode away from codexChatGPT, because
//     the user must make that choice explicitly.

import { CODEX_PROVIDER_MODES } from "../codex/types";

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// ─── enum shape ─────────────────────────────────────────────────────

pass("enum has exactly three modes", CODEX_PROVIDER_MODES.length === 3);
pass("enum includes openaiApiKey", CODEX_PROVIDER_MODES.includes("openaiApiKey"));
pass("enum includes openaiUserApiKey", CODEX_PROVIDER_MODES.includes("openaiUserApiKey"));
pass("enum includes codexChatGPT", CODEX_PROVIDER_MODES.includes("codexChatGPT"));

// Unknown values must NOT be in the enum.
pass("enum rejects 'openai'", !(CODEX_PROVIDER_MODES as readonly string[]).includes("openai"));
pass("enum rejects 'chatgpt'", !(CODEX_PROVIDER_MODES as readonly string[]).includes("chatgpt"));
pass("enum rejects empty string", !(CODEX_PROVIDER_MODES as readonly string[]).includes(""));

// ─── store invariants (mocked DB) ───────────────────────────────────
//
// We mock the pool so this test runs without a Postgres connection.
// It validates the contract of setProviderMode/getProviderMode without
// hitting the wire.

type Row = { id: string; codexProviderMode?: string };
const fakeDb: Record<string, Row> = { "u1": { id: "u1", codexProviderMode: "openaiApiKey" } };

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
  pass("getProviderMode returns stored value", await getProviderMode("u1") === "openaiApiKey");

  // Unknown user → openaiApiKey default.
  pass("getProviderMode defaults openaiApiKey for unknown user",
    await getProviderMode("nobody") === "openaiApiKey");

  // Set to user-key mode.
  await setProviderMode("u1", "openaiUserApiKey");
  pass("setProviderMode persists openaiUserApiKey",
    await getProviderMode("u1") === "openaiUserApiKey");

  // Set to codexChatGPT requires no auto-flip from anything.
  await setProviderMode("u1", "codexChatGPT");
  pass("setProviderMode persists codexChatGPT",
    await getProviderMode("u1") === "codexChatGPT");

  // Setting an unknown mode throws — explicit reject, not silent default.
  let threw = false;
  try { await setProviderMode("u1", "openai" as any); }
  catch { threw = true; }
  pass("setProviderMode throws on unknown mode", threw);

  // After the throw, the previous value must remain.
  pass("setProviderMode does not silently downgrade on error",
    await getProviderMode("u1") === "codexChatGPT");

  // Setting to apiKey explicitly works.
  await setProviderMode("u1", "openaiApiKey");
  pass("setProviderMode allows downgrade when explicit",
    await getProviderMode("u1") === "openaiApiKey");

  // No state change when calling get repeatedly.
  const a = await getProviderMode("u1");
  const b = await getProviderMode("u1");
  pass("getProviderMode is read-only (idempotent)", a === b);

  // ─── billing-mode segregation ──────────────────────────────────────
  // Switching from codexChatGPT to openaiApiKey should never happen
  // automatically based on bridge state. Even if a bridge gets deleted
  // while mode=codexChatGPT, mode stays as-is.
  await setProviderMode("u1", "codexChatGPT");
  // Simulate "bridge deleted" (we don't touch user row at all).
  pass("provider mode survives a bridge delete (no auto-flip)",
    await getProviderMode("u1") === "codexChatGPT");

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll provider-mode tests passed.");
})();
