// P42 — Notification preferences + Web Push subscription endpoint.
//
//   GET   /api/notifications → { preferences, subscriptions }
//   PATCH /api/notifications  body: { preferences? }
//   POST  /api/notifications  body: { subscription }    (register Web Push)
//
// Preferences are per-event toggles stored on the existing users.preferences
// JSONB column. Web Push subscriptions live in a dedicated table so they
// can be enumerated + revoked.
//
// Per-event keys (with defaults):
//   thread_complete: true     — agent finished a turn while the tab was inactive
//   thread_failed: true       — turn errored
//   plan_ready: true          — plan-first paused for review
//   credit_low: true          — balance drops below 1k credits
//   schedule_completed: false — scheduled run finished
//   security_event: true      — login from new device, password change

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getPrefs, setPrefs } from "@/lib/preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DEFAULT_NOTIFICATION_PREFS = {
  thread_complete: true,
  thread_failed: true,
  plan_ready: true,
  credit_low: true,
  schedule_completed: false,
  security_event: true,
};

let _initialized = false;
async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      "p256dh" TEXT NOT NULL,
      auth TEXT NOT NULL,
      "userAgent" TEXT,
      "createdAt" BIGINT NOT NULL,
      UNIQUE("userId", endpoint)
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions("userId");
  `);
  _initialized = true;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureSchema();
  const prefs = await getPrefs(user.id);
  const merged = { ...DEFAULT_NOTIFICATION_PREFS, ...(prefs.notifications || {}) };
  const subs = await pool().query(
    `SELECT id, endpoint, "userAgent", "createdAt" FROM push_subscriptions WHERE "userId"=$1 ORDER BY "createdAt" DESC`,
    [user.id],
  );
  return NextResponse.json({
    preferences: merged,
    subscriptions: subs.rows.map((r: any) => ({
      ...r, createdAt: Number(r.createdAt),
      // Mask the endpoint host for display.
      endpointDomain: (() => { try { return new URL(r.endpoint).host; } catch { return "unknown"; } })(),
    })),
  });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body.preferences || typeof body.preferences !== "object") {
    return NextResponse.json({ error: "preferences object required" }, { status: 400 });
  }
  // Whitelist keys to avoid arbitrary writes.
  const sanitized: Record<string, boolean> = {};
  for (const k of Object.keys(DEFAULT_NOTIFICATION_PREFS)) {
    if (typeof body.preferences[k] === "boolean") sanitized[k] = body.preferences[k];
  }
  const cur = await getPrefs(user.id);
  await setPrefs(user.id, {
    notifications: { ...(cur.notifications || {}), ...sanitized },
  });
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureSchema();
  const body = await req.json().catch(() => ({}));
  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return NextResponse.json({ error: "invalid subscription shape" }, { status: 400 });
  }
  const id = "ps_" + crypto.randomBytes(8).toString("hex");
  const ua = req.headers.get("user-agent")?.slice(0, 200) || null;
  // Idempotent on (userId, endpoint).
  await pool().query(
    `INSERT INTO push_subscriptions (id, "userId", endpoint, "p256dh", auth, "userAgent", "createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT ("userId", endpoint) DO UPDATE SET "p256dh"=EXCLUDED."p256dh", auth=EXCLUDED.auth`,
    [id, user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, ua, Date.now()],
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureSchema();
  const u = new URL(req.url);
  const id = u.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  await pool().query(`DELETE FROM push_subscriptions WHERE id=$1 AND "userId"=$2`, [id, user.id]);
  return NextResponse.json({ ok: true });
}
