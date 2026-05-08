// User settings: preferred model, theme, etc.
// Stored in users.preferences JSON column (added lazily on first GET).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { DEFAULT_MODEL_ID, MODELS } from "@/lib/models";

async function ensureColumn() {
  await getDb().query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb`);
}

async function getPrefs(userId: string): Promise<Record<string, any>> {
  await ensureColumn();
  const r = await getDb().query(`SELECT preferences FROM users WHERE id=$1`, [userId]);
  return r.rows[0]?.preferences || {};
}

async function setPrefs(userId: string, prefs: Record<string, any>) {
  await ensureColumn();
  await getDb().query(`UPDATE users SET preferences = preferences || $1::jsonb WHERE id=$2`, [JSON.stringify(prefs), userId]);
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const prefs = await getPrefs(user.id);
  return NextResponse.json({
    preferences: {
      modelId: prefs.modelId || DEFAULT_MODEL_ID,
      theme: prefs.theme || "light",
      ...prefs,
    },
    models: MODELS,
  });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  await setPrefs(user.id, body);
  return NextResponse.json({ ok: true });
}

export async function getUserPreferredModel(userId: string): Promise<string> {
  const prefs = await getPrefs(userId);
  return prefs.modelId || DEFAULT_MODEL_ID;
}
