// P63 — Manus → Hyperagent import.
//
// Parses a Manus export (JSON file, optionally inside a zip wrapper)
// and inserts threads / agents / memories under the user's account.
// Idempotent: each external row carries its own `id` from Manus, which
// we record in a tracking table so duplicate uploads are skipped.

import { pool } from "./db";
import { createThread, createMessage, createAgent, createMemory } from "./db";

let _initialized = false;
async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS manus_import_history (
      id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "fileName" TEXT NOT NULL,
      "threadsImported" INTEGER NOT NULL DEFAULT 0,
      "agentsImported" INTEGER NOT NULL DEFAULT 0,
      "memoriesImported" INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      errored INTEGER NOT NULL DEFAULT 0,
      "createdAt" BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_manus_imports_user
      ON manus_import_history("userId", "createdAt" DESC);

    CREATE TABLE IF NOT EXISTS manus_import_rows (
      "userId" TEXT NOT NULL,
      "externalId" TEXT NOT NULL,
      kind TEXT NOT NULL,
      "internalId" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      PRIMARY KEY ("userId", "externalId", kind)
    );
  `);
  _initialized = true;
}

export interface ManusExport {
  threads?: Array<{
    id?: string;
    title?: string;
    createdAt?: number;
    messages?: Array<{ role: "user" | "assistant" | "system"; content: string; createdAt?: number }>;
  }>;
  agents?: Array<{
    id?: string;
    name?: string;
    description?: string;
    systemPrompt?: string;
    color?: string;
    icon?: string;
  }>;
  memories?: Array<{
    id?: string;
    content?: string;
    importance?: number;
  }>;
}

export interface ImportSummary {
  ok: boolean;
  threadsImported: number;
  agentsImported: number;
  memoriesImported: number;
  skipped: number;
  errors: string[];
}

/**
 * Run an import. Returns counts + a list of error messages (truncated).
 * Records a manus_import_history row + per-entity rows in
 * manus_import_rows so re-uploads are deduped.
 */
export async function importManusExport(
  userId: string,
  fileName: string,
  data: ManusExport,
): Promise<ImportSummary> {
  await ensureSchema();
  const errors: string[] = [];
  let threadsImported = 0, agentsImported = 0, memoriesImported = 0, skipped = 0;

  const importedExternal = new Set<string>();
  if (Array.isArray(data.threads)) {
    for (const t of data.threads) {
      try {
        if (!t.id) { errors.push("thread missing id; skipped"); continue; }
        const key = `thread:${t.id}`;
        if (await alreadyImported(userId, t.id, "thread")) { skipped++; continue; }
        if (importedExternal.has(key)) { skipped++; continue; }

        const thread = await createThread(userId, t.title || "Imported thread", null);
        if (Array.isArray(t.messages)) {
          for (const m of t.messages) {
            if (!m || !m.role || typeof m.content !== "string") continue;
            await createMessage({
              threadId: thread.id,
              role: m.role === "system" ? "user" : m.role,
              content: m.content,
            });
          }
        }
        await recordImported(userId, t.id, "thread", thread.id);
        importedExternal.add(key);
        threadsImported++;
      } catch (e: any) {
        errors.push(`thread ${t.id || "(no id)"}: ${e?.message || e}`);
      }
    }
  }

  if (Array.isArray(data.agents)) {
    for (const a of data.agents) {
      try {
        if (!a.id) { errors.push("agent missing id; skipped"); continue; }
        if (await alreadyImported(userId, a.id, "agent")) { skipped++; continue; }
        const created = await createAgent({
          userId,
          name: a.name || "Imported agent",
          description: a.description || "",
          systemPrompt: a.systemPrompt || "",
          icon: a.icon || "🤖",
          color: validateColor(a.color),
          tools: ["web_search", "generate_artifact"],
          connectorIds: [],
          routerHint: "",
        });
        await recordImported(userId, a.id, "agent", created.id);
        agentsImported++;
      } catch (e: any) {
        errors.push(`agent ${a.id || "(no id)"}: ${e?.message || e}`);
      }
    }
  }

  if (Array.isArray(data.memories)) {
    for (const m of data.memories) {
      try {
        if (!m.id) { errors.push("memory missing id; skipped"); continue; }
        if (await alreadyImported(userId, m.id, "memory")) { skipped++; continue; }
        const created = await createMemory({
          userId,
          agentId: null,
          projectId: null,
          content: String(m.content || "").slice(0, 4000),
          importance: clampInt(m.importance, 0, 10, 5),
        });
        await recordImported(userId, m.id, "memory", created.id);
        memoriesImported++;
      } catch (e: any) {
        errors.push(`memory ${m.id || "(no id)"}: ${e?.message || e}`);
      }
    }
  }

  // Record the import in history.
  const id = "mi_" + Math.random().toString(36).slice(2, 12);
  await pool().query(`
    INSERT INTO manus_import_history (id, "userId", "fileName", "threadsImported", "agentsImported", "memoriesImported", skipped, errored, "createdAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [id, userId, fileName.slice(0, 200), threadsImported, agentsImported, memoriesImported, skipped, errors.length, Date.now()]);

  return {
    ok: errors.length === 0 || (threadsImported + agentsImported + memoriesImported) > 0,
    threadsImported, agentsImported, memoriesImported, skipped,
    errors: errors.slice(0, 50),
  };
}

export interface ImportRecord {
  id: string;
  fileName: string;
  threadsImported: number;
  agentsImported: number;
  memoriesImported: number;
  skipped: number;
  errored: number;
  createdAt: number;
}
export async function listImports(userId: string, limit = 30): Promise<ImportRecord[]> {
  await ensureSchema();
  const r = await pool().query(`
    SELECT id, "fileName", "threadsImported", "agentsImported", "memoriesImported", skipped, errored, "createdAt"
      FROM manus_import_history WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT $2
  `, [userId, limit]);
  return r.rows;
}

export async function clearImportHistory(userId: string): Promise<void> {
  await ensureSchema();
  await pool().query(`DELETE FROM manus_import_history WHERE "userId"=$1`, [userId]);
  // Note: manus_import_rows is intentionally NOT cleared so a re-upload
  // still skips already-imported items. Users who really want to re-import
  // need to delete those entities manually.
}

// ─── helpers ─────────────────────────────────────────────────────────

async function alreadyImported(userId: string, externalId: string, kind: string): Promise<boolean> {
  const r = await pool().query(
    `SELECT 1 FROM manus_import_rows WHERE "userId"=$1 AND "externalId"=$2 AND kind=$3 LIMIT 1`,
    [userId, externalId, kind],
  );
  return r.rowCount! > 0;
}

async function recordImported(userId: string, externalId: string, kind: string, internalId: string) {
  await pool().query(`
    INSERT INTO manus_import_rows ("userId", "externalId", kind, "internalId", "createdAt")
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT ("userId", "externalId", kind) DO NOTHING
  `, [userId, externalId, kind, internalId, Date.now()]);
}

function validateColor(c: any): "orange" | "blue" | "green" | "purple" {
  return c === "blue" || c === "green" || c === "purple" ? c : "orange";
}

function clampInt(v: any, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
