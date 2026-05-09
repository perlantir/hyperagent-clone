// P58 — HyperAgent thread ↔ Codex thread mapping.
//
// Each HyperAgent thread that runs in codexChatGPT mode owns exactly one
// Codex thread inside the bridge. We store the mapping in our DB so
// subsequent turns reuse the same Codex thread (preserving Codex-side
// memory + history). On a fork, we either fork inside Codex or start a
// fresh Codex thread depending on what the bridge supports.

import { pool } from "../db";

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS codex_thread_map (
      "threadId" TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      "codexThreadId" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL
    );
  `);
  _initialized = true;
}

export async function getCodexThreadId(threadId: string): Promise<string | null> {
  await ensureSchema();
  const r = await pool().query(
    `SELECT "codexThreadId" FROM codex_thread_map WHERE "threadId"=$1`,
    [threadId],
  );
  return r.rows[0]?.codexThreadId || null;
}

export async function setCodexThreadId(threadId: string, codexThreadId: string): Promise<void> {
  await ensureSchema();
  const now = Date.now();
  await pool().query(`
    INSERT INTO codex_thread_map ("threadId", "codexThreadId", "createdAt")
    VALUES ($1, $2, $3)
    ON CONFLICT ("threadId") DO UPDATE
      SET "codexThreadId"=EXCLUDED."codexThreadId"
  `, [threadId, codexThreadId, now]);
}

export async function clearCodexThreadId(threadId: string): Promise<void> {
  await ensureSchema();
  await pool().query(`DELETE FROM codex_thread_map WHERE "threadId"=$1`, [threadId]);
}
