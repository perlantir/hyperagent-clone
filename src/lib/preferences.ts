// User preferences storage. Stored in users.preferences JSON column,
// added lazily on first read.

import { pool } from "./db";
import { DEFAULT_MODEL_ID } from "./models";

let _columnEnsured = false;

async function ensureColumn() {
  if (_columnEnsured) return;
  await pool().query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb`);
  _columnEnsured = true;
}

export async function getPrefs(userId: string): Promise<Record<string, any>> {
  await ensureColumn();
  const r = await pool().query(`SELECT preferences FROM users WHERE id=$1`, [userId]);
  return r.rows[0]?.preferences || {};
}

export async function setPrefs(userId: string, patch: Record<string, any>) {
  await ensureColumn();
  await pool().query(`UPDATE users SET preferences = preferences || $1::jsonb WHERE id=$2`, [JSON.stringify(patch), userId]);
}

export async function getUserPreferredModel(userId: string): Promise<string> {
  const prefs = await getPrefs(userId);
  return prefs.modelId || DEFAULT_MODEL_ID;
}
