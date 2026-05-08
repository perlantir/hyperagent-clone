// Manage Slack workspaces bound to this user.
//   GET  /api/settings/slack-workspaces   → list user's bound workspaces (bot token redacted)
//   POST /api/settings/slack-workspaces   → bind a workspace. Body: { teamId, botToken, agentId? }
//
// The slack_workspaces table is created lazily by /api/slack/events on first
// inbound webhook; we ensure it exists here so the user can pre-bind before
// any events arrive.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";

export const runtime = "nodejs";

async function ensureTables() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS slack_workspaces (
      team_id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES users(id),
      "agentId" TEXT REFERENCES agents(id) ON DELETE SET NULL,
      "botToken" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slack_threads (
      slack_channel TEXT NOT NULL,
      slack_ts TEXT NOT NULL,
      "threadId" TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      PRIMARY KEY (slack_channel, slack_ts)
    );
  `);
}

function redact(token: string) {
  if (!token) return "";
  return token.length <= 12 ? "•".repeat(token.length) : token.slice(0, 8) + "•".repeat(8) + token.slice(-4);
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureTables();
  const r = await pool().query(
    `SELECT team_id, "agentId", "botToken", "createdAt"
     FROM slack_workspaces WHERE "userId"=$1 ORDER BY "createdAt" DESC`,
    [user.id],
  );
  return NextResponse.json({
    workspaces: r.rows.map((w: any) => ({
      teamId: w.team_id, agentId: w.agentId,
      botTokenRedacted: redact(w.botToken),
      createdAt: w.createdAt,
    })),
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { teamId, botToken, agentId } = await req.json().catch(() => ({}));
  if (!teamId || typeof teamId !== "string" || !teamId.startsWith("T")) {
    return NextResponse.json({ error: "teamId is required (Slack team ID, starts with T)" }, { status: 400 });
  }
  if (!botToken || typeof botToken !== "string" || !botToken.startsWith("xoxb-")) {
    return NextResponse.json({ error: "botToken must be a Slack bot token (xoxb-…)" }, { status: 400 });
  }
  await ensureTables();
  // Verify token works by hitting auth.test
  try {
    const r = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { "Authorization": `Bearer ${botToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const j = await r.json();
    if (!j.ok) return NextResponse.json({ error: `Slack rejected token: ${j.error}` }, { status: 400 });
    if (j.team_id && j.team_id !== teamId) {
      return NextResponse.json({ error: `Token belongs to team ${j.team_id}, not ${teamId}` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: `Slack verification failed: ${e.message}` }, { status: 502 });
  }

  await pool().query(
    `INSERT INTO slack_workspaces (team_id, "userId", "agentId", "botToken", "createdAt")
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (team_id) DO UPDATE
       SET "agentId"=EXCLUDED."agentId", "botToken"=EXCLUDED."botToken"`,
    [teamId, user.id, agentId || null, botToken, Date.now()],
  );
  return NextResponse.json({ ok: true });
}
