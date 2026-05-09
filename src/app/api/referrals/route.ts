// P42 — Referrals.
//
//   GET  /api/referrals  → { code, link, stats: {count, signups, creditedAt}, referees }
//   POST /api/referrals { email? }  → { ok }    (track an email-invite event)
//
// Each user gets a stable referral code (8 chars). Signups using that
// code on /login record a referees row; the referrer earns credits when
// the referee converts (signs up + first non-trivial run).

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFERRER_CREDIT = 100_000;  // ~$100 in our credit unit
const REFEREE_CREDIT = 1_000_000; // ~$1000 (signup bonus from Hyperagent's reference offer)

let _initialized = false;
async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS referral_codes (
      "userId" TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL UNIQUE,
      "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS referral_events (
      id TEXT PRIMARY KEY,
      "referrerUserId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "refereeUserId" TEXT REFERENCES users(id) ON DELETE SET NULL,
      "refereeEmail" TEXT,
      kind TEXT NOT NULL,         -- 'invite' | 'signup' | 'converted'
      credited BOOLEAN NOT NULL DEFAULT FALSE,
      "createdAt" BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_referral_events_referrer ON referral_events("referrerUserId", "createdAt" DESC);
  `);
  _initialized = true;
}

async function ensureCodeFor(userId: string): Promise<string> {
  const existing = await pool().query(`SELECT code FROM referral_codes WHERE "userId"=$1`, [userId]);
  if (existing.rows[0]) return existing.rows[0].code;
  // Generate a new one with retry-on-collision.
  for (let i = 0; i < 5; i++) {
    const code = crypto.randomBytes(4).toString("base64url").replace(/[_-]/g, "").slice(0, 8).toUpperCase();
    try {
      await pool().query(
        `INSERT INTO referral_codes ("userId", code, "createdAt") VALUES ($1,$2,$3)`,
        [userId, code, Date.now()],
      );
      return code;
    } catch { /* collision; retry */ }
  }
  throw new Error("referral code generation exhausted retries");
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureSchema();
  const code = await ensureCodeFor(user.id);

  const stats = await pool().query(
    `SELECT
       COUNT(*) FILTER (WHERE kind='invite')::int   AS invites,
       COUNT(*) FILTER (WHERE kind='signup')::int   AS signups,
       COUNT(*) FILTER (WHERE kind='converted')::int AS converted,
       COALESCE(SUM(CASE WHEN credited THEN 1 ELSE 0 END), 0)::int AS credited_count
     FROM referral_events WHERE "referrerUserId"=$1`,
    [user.id],
  );
  const referees = await pool().query(
    `SELECT id, "refereeUserId", "refereeEmail", kind, credited, "createdAt"
     FROM referral_events WHERE "referrerUserId"=$1
     ORDER BY "createdAt" DESC LIMIT 50`,
    [user.id],
  );

  const origin = (() => { try { return new URL(req.url).origin; } catch { return ""; } })();
  return NextResponse.json({
    code,
    link: `${origin}/login?ref=${code}`,
    rewards: { referrer: REFERRER_CREDIT, referee: REFEREE_CREDIT },
    stats: stats.rows[0] || { invites: 0, signups: 0, converted: 0, credited_count: 0 },
    referees: referees.rows.map((r: any) => ({ ...r, createdAt: Number(r.createdAt) })),
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureSchema();
  const body = await req.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : null;
  await pool().query(
    `INSERT INTO referral_events (id, "referrerUserId", "refereeEmail", kind, "createdAt") VALUES ($1,$2,$3,'invite',$4)`,
    ["re_" + crypto.randomBytes(8).toString("hex"), user.id, email, Date.now()],
  );
  return NextResponse.json({ ok: true });
}
