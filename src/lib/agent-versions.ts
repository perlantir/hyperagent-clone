// P28b — Agent versioning.
//
// Snapshots an agent's mutable config every time it changes, so we can:
//   1. Show a version history on the agent page (audit trail).
//   2. Roll back to a previous version.
//   3. Tag traces with the agentVersion in effect at run time, so a
//      replay against the "current" agent makes the diff legible
//      (this snapshot vs. that snapshot).
//
// Storage model: append-only `agent_versions` table. Each row captures
// the full set of mutable fields at write time. We don't dedupe identical
// snapshots (cost is negligible; idempotency is more important than space).
// Version numbers are monotonic per-agent (1, 2, 3, ...).

import { pool } from "./db";
import crypto from "node:crypto";

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  name: string;
  icon: string;
  color: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  connectorIds: string[];
  routerHint: string;
  createdAt: number;
  changedBy: string | null;
  changeNote: string | null;
}

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id TEXT PRIMARY KEY,
      "agentId" TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      color TEXT NOT NULL,
      description TEXT NOT NULL,
      "systemPrompt" TEXT NOT NULL,
      tools TEXT NOT NULL,
      "connectorIds" TEXT NOT NULL DEFAULT '[]',
      "routerHint" TEXT NOT NULL DEFAULT '',
      "createdAt" BIGINT NOT NULL,
      "changedBy" TEXT,
      "changeNote" TEXT,
      UNIQUE("agentId", version)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_versions_agent
      ON agent_versions("agentId", version DESC);
  `);
  _initialized = true;
}

// Write a snapshot of the agent's current state. Returns the new version
// number. Pulls from the live `agents` row, so callers should call this
// BEFORE writing a change (capture the old state) — though calling AFTER
// also works and just records the new state.
export async function snapshotAgent(
  agentId: string,
  changedBy: string | null = null,
  changeNote: string | null = null,
): Promise<number> {
  await ensureSchema();
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const a = await c.query(`SELECT * FROM agents WHERE id=$1 FOR UPDATE`, [agentId]);
    const row = a.rows[0];
    if (!row) {
      await c.query("ROLLBACK");
      throw new Error("agent not found");
    }
    // Compute next version: max(version) + 1, or 1 if none.
    const v = await c.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM agent_versions WHERE "agentId"=$1`,
      [agentId],
    );
    const nextVersion = v.rows[0].next;
    const id = "av_" + crypto.randomBytes(8).toString("hex");
    await c.query(
      `INSERT INTO agent_versions
       (id, "agentId", version, name, icon, color, description, "systemPrompt",
        tools, "connectorIds", "routerHint", "createdAt", "changedBy", "changeNote")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id, agentId, nextVersion,
        row.name, row.icon, row.color, row.description, row.systemPrompt,
        row.tools, row.connectorIds, row.routerHint,
        Date.now(), changedBy, changeNote,
      ],
    );
    await c.query("COMMIT");
    return nextVersion;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

// List versions for an agent, newest first.
export async function listAgentVersions(
  agentId: string,
  userId: string,
  limit = 50,
): Promise<AgentVersion[]> {
  await ensureSchema();
  // Authz: ensure the agent belongs to this user.
  const own = await pool().query(
    `SELECT "userId" FROM agents WHERE id=$1`,
    [agentId],
  );
  if (!own.rows[0] || own.rows[0].userId !== userId) return [];
  const r = await pool().query(
    `SELECT * FROM agent_versions WHERE "agentId"=$1 ORDER BY version DESC LIMIT $2`,
    [agentId, limit],
  );
  return r.rows.map(row => ({
    ...row,
    tools: JSON.parse(row.tools),
    connectorIds: JSON.parse(row.connectorIds || "[]"),
  }));
}

// Read the current latest version number for an agent (or 0 if no
// snapshots exist yet — meaning the agent hasn't been edited since
// versioning shipped).
export async function getCurrentAgentVersion(agentId: string): Promise<number> {
  await ensureSchema();
  const r = await pool().query(
    `SELECT COALESCE(MAX(version), 0) AS v FROM agent_versions WHERE "agentId"=$1`,
    [agentId],
  );
  return Number(r.rows[0]?.v || 0);
}

// Roll back: load the snapshot at `version`, write its fields back to the
// `agents` row, and snapshot the (now overwritten) state as a NEW version
// so the rollback itself is reversible.
export async function rollbackAgentToVersion(
  agentId: string,
  userId: string,
  version: number,
  note?: string,
): Promise<{ ok: boolean; newVersion?: number; reason?: string }> {
  await ensureSchema();
  // Authz
  const own = await pool().query(`SELECT "userId" FROM agents WHERE id=$1`, [agentId]);
  if (!own.rows[0] || own.rows[0].userId !== userId) {
    return { ok: false, reason: "not found" };
  }
  // First snapshot current state so the rollback is reversible.
  await snapshotAgent(agentId, userId, `pre-rollback (was about to rollback to v${version})`);

  // Load the target version.
  const t = await pool().query(
    `SELECT * FROM agent_versions WHERE "agentId"=$1 AND version=$2`,
    [agentId, version],
  );
  const target = t.rows[0];
  if (!target) return { ok: false, reason: `version ${version} not found` };

  // Write back to agents.
  await pool().query(
    `UPDATE agents SET
       name=$1, icon=$2, color=$3, description=$4, "systemPrompt"=$5,
       tools=$6, "connectorIds"=$7, "routerHint"=$8
     WHERE id=$9 AND "userId"=$10`,
    [
      target.name, target.icon, target.color, target.description,
      target.systemPrompt, target.tools, target.connectorIds, target.routerHint,
      agentId, userId,
    ],
  );
  // Snapshot the post-rollback state so the version history reflects it.
  const newVersion = await snapshotAgent(agentId, userId, note || `rolled back to v${version}`);
  return { ok: true, newVersion };
}
