// Slack inbound webhook (P15).
// Handles two payload types:
//   1. url_verification — Slack handshake, echo back the challenge
//   2. event_callback   — incoming message in a channel where the bot is added
//
// For each user message, we look up the user-level Slack mapping (by team_id),
// find or create a thread, and stream a response back to the channel via
// chat.postMessage. Bot mentions and DMs both supported.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { pool } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

async function verifySlackSignature(req: Request, body: string): Promise<boolean> {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true; // dev mode
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${body}`;
  const mac = crypto.createHmac("sha256", secret).update(base).digest("hex");
  const computed = `v0=${mac}`;
  try { return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig)); }
  catch { return false; }
}

async function ensureSlackTable() {
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

export async function POST(req: Request) {
  const body = await req.text();
  if (!(await verifySlackSignature(req, body))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  const payload = JSON.parse(body);

  // Handshake — Slack pings this when configuring the URL
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback") return NextResponse.json({ ok: true });

  const event = payload.event;
  const teamId = payload.team_id;
  if (!event || event.bot_id || !event.text) return NextResponse.json({ ok: true });
  if (event.type !== "message" && event.type !== "app_mention") return NextResponse.json({ ok: true });

  await ensureSlackTable();
  // Look up which Hyperagent workspace owns this Slack team
  const ws = await pool().query(`SELECT * FROM slack_workspaces WHERE team_id=$1`, [teamId]);
  const row = ws.rows[0];
  if (!row) return NextResponse.json({ ok: true, note: "no workspace bound to this Slack team" });

  // Process inline (Slack expects ack within 3s — for long replies we'd push to a queue)
  // Here we just dispatch and return; the actual reply will arrive via chat.postMessage.
  processSlackMessage({
    userId: row.userId,
    agentId: row.agentId,
    botToken: row.botToken,
    channel: event.channel,
    user: event.user,
    text: event.text,
    threadTs: event.thread_ts || event.ts,
  }).catch(e => console.error("[slack handler]", e));

  return NextResponse.json({ ok: true });
}

async function processSlackMessage(p: {
  userId: string; agentId: string | null; botToken: string;
  channel: string; user: string; text: string; threadTs: string;
}) {
  const { findOrCreateSlackThread, runAgentForSlack, postSlackReply } = await import("@/lib/slack-handler");
  const threadId = await findOrCreateSlackThread(p.userId, p.agentId, p.channel, p.threadTs, p.text);
  const reply = await runAgentForSlack(p.userId, p.agentId, threadId, p.text);
  await postSlackReply(p.botToken, p.channel, p.threadTs, reply);
}
