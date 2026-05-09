// P41 — Inbound email webhook (SendGrid Inbound Parse target).
//
//   POST /api/email/inbound  Content-Type: multipart/form-data
//
// SendGrid Inbound Parse forwards every email received at the configured
// MX domain as a multipart/form-data POST. Shape:
//   - to:      "agent-name@agents.hyperagent.app, …"
//   - from:    "user@example.com"
//   - subject: "..."
//   - text:    plain-text body
//   - html:    HTML body
//   - attachments, attachment-info, etc.
//
// We:
//   1. Verify origin via shared secret (process.env.SENDGRID_INBOUND_SECRET
//      sent as Bearer token) — SendGrid lets you configure a basic-auth
//      URL, but for our purposes a custom header works the same way.
//   2. Look up the recipient address in agent_email_addresses.
//   3. Run the agent's chat with the email body as the user message;
//      reply-via-email lands in a follow-on slice.
//
// For the v1 cut we route the inbound email into a NEW thread and surface
// the resulting agent reply via that thread. The user can wire up an
// outbound-email tool later to close the loop.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { pool } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SHARED_SECRET = process.env.SENDGRID_INBOUND_SECRET;

function authorized(req: Request): boolean {
  if (!SHARED_SECRET) {
    // Dev-mode: no secret configured → accept all (operator's call).
    // Audit-log this so it's visible.
    return true;
  }
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(m[1]),
      Buffer.from(SHARED_SECRET),
    );
  } catch { return false; }
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    await audit({
      userId: null, action: "webhook.rejected", resource: "email/inbound",
      result: "denied", metadata: { reason: "bad shared secret" },
      ...auditFromRequest(req),
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Parse the multipart payload. SendGrid sends classic form-data.
  let to = ""; let from = ""; let subject = ""; let text = ""; let html = "";
  try {
    const fd = await req.formData();
    to = String(fd.get("to") || "");
    from = String(fd.get("from") || "");
    subject = String(fd.get("subject") || "");
    text = String(fd.get("text") || "");
    html = String(fd.get("html") || "");
  } catch (e) {
    // Some providers send JSON instead. Try that as a fallback.
    try {
      const j = await req.json();
      to = j.to || ""; from = j.from || "";
      subject = j.subject || ""; text = j.text || ""; html = j.html || "";
    } catch {
      return NextResponse.json({ error: "could not parse body" }, { status: 400 });
    }
  }

  // Resolve recipient → agent. Pick the first known address from `to`.
  // (Multiple recipients in `to` is rare for inbound; we fan-out one
  // turn per matching address rather than fail-on-ambiguous.)
  const candidates = to.split(",").map(s => extractAddress(s.trim())).filter(Boolean);
  if (candidates.length === 0) {
    return NextResponse.json({ error: "no addressable recipient" }, { status: 400 });
  }
  const r = await pool().query(
    `SELECT a.id AS "addrId", a.address, a."userId", a."agentId", g.name AS "agentName"
     FROM agent_email_addresses a
     JOIN agents g ON g.id = a."agentId"
     WHERE a.address = ANY($1::text[])`,
    [candidates],
  );
  if (r.rows.length === 0) {
    await audit({
      userId: null, action: "webhook.rejected", resource: "email/inbound",
      result: "denied", metadata: { reason: "no matching agent", to },
      ...auditFromRequest(req),
    });
    return NextResponse.json({ error: "no agent registered for this address" }, { status: 404 });
  }

  // For each match, create a thread + post the email body as the user
  // message. Returns the spawned thread ids.
  const spawned: any[] = [];
  for (const row of r.rows) {
    const messageBody = text || stripHtml(html);
    const title = subject ? subject.slice(0, 60) : `Email from ${from || "unknown"}`;

    // Create thread bound to the agent
    const threadId = "t_" + crypto.randomBytes(8).toString("hex");
    const now = Date.now();
    await pool().query(
      `INSERT INTO threads (id, "userId", "projectId", title, "agentId", "createdAt", "updatedAt")
       VALUES ($1,$2,NULL,$3,$4,$5,$5)`,
      [threadId, row.userId, title, row.agentId, now],
    );

    // Persist user message — actual chat execution intentionally deferred:
    // running the LLM synchronously inside the inbound webhook would block
    // SendGrid's tight timeout. The chat lambda is invoked via the user's
    // browser when they next open the thread, OR we can fire a follow-on
    // background task. For v1 we simply persist + notify; the agent's
    // reply lands when the user opens the thread (or via a scheduled
    // dispatcher in a follow-up slice).
    const userMsgId = "m_" + crypto.randomBytes(8).toString("hex");
    await pool().query(
      `INSERT INTO messages (id, "threadId", role, content, "createdAt")
       VALUES ($1,$2,'user',$3,$4)`,
      [userMsgId, threadId, `[Email from ${from} — ${subject}]\n\n${messageBody}`, now],
    );

    // Bump address counters
    await pool().query(
      `UPDATE agent_email_addresses
       SET "lastReceivedAt"=$1, "messageCount"="messageCount"+1
       WHERE id=$2`,
      [now, row.addrId],
    );

    spawned.push({ agentId: row.agentId, agentName: row.agentName, threadId });
  }

  await audit({
    userId: r.rows[0].userId, action: "webhook.received", resource: "email/inbound",
    result: "success",
    metadata: {
      to, from, subject,
      bodyBytes: text.length,
      spawnedThreads: spawned.length,
    },
    ...auditFromRequest(req),
  });

  return NextResponse.json({ ok: true, threads: spawned });
}

// Extract bare email address from "Name <user@example.com>" form.
function extractAddress(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).toLowerCase().trim();
}

// Crude HTML stripper for emails sent without text/plain. Good enough
// for the input fed to the model — the chat route will still see "email
// body content" semantics.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
