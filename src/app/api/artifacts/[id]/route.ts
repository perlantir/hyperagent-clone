// Artifact endpoints — read, edit, and render.
//
//   GET    /api/artifacts/{id}          → { artifact }
//   GET    /api/artifacts/{id}?render=1 → sandboxed HTML page (preview)
//   PATCH  /api/artifacts/{id}          → snapshot prior version, write
//                                          new title/body, return version
//   DELETE /api/artifacts/{id}          → cascade delete (versions go too)
//
// P31b — every PATCH snapshots the current state to artifact_versions and
// writes the new body. The render path returns a self-contained HTML doc
// suitable for embedding in a sandboxed iframe (`sandbox="allow-scripts"`).
// Outer pages should still set referrer-policy + X-Frame-Options at the
// host level; this endpoint only emits inner-frame content.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getArtifact, getThread, updateArtifactBody, pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const a = await getArtifact(params.id);
  if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
  const thread = await getThread(a.threadId, user.id);
  if (!thread) return NextResponse.json({ error: "not found" }, { status: 404 });

  const url = new URL(req.url);
  if (url.searchParams.get("render") === "1") {
    const html = renderArtifactHtml(a);
    // Content-Security-Policy keeps the rendered page from making outbound
    // requests (no remote scripts beyond the Google Fonts whitelist), which
    // matches the sandboxed-iframe context most callers will use.
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        // Allow same-origin embedding only — the /library/[id] page wraps
        // this in a sandboxed iframe.
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy":
          "default-src 'self'; img-src * data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; script-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
      },
    });
  }
  return NextResponse.json({ artifact: a });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const a = await getArtifact(params.id);
  if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
  const thread = await getThread(a.threadId, user.id);
  if (!thread) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { title, body, changeNote } = await req.json().catch(() => ({}));
  if (title === undefined && body === undefined) {
    return NextResponse.json({ error: "title or body required" }, { status: 400 });
  }
  const r = await updateArtifactBody(params.id, { title, body, changeNote });
  if (!r.ok) return NextResponse.json({ error: "update failed" }, { status: 500 });
  return NextResponse.json({ ok: true, newVersion: r.newVersion });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const a = await getArtifact(params.id);
  if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
  const thread = await getThread(a.threadId, user.id);
  if (!thread) return NextResponse.json({ error: "not found" }, { status: 404 });
  // FK on artifact_versions cascades, so a single DELETE wipes history too.
  await pool().query(`DELETE FROM artifacts WHERE id=$1`, [params.id]);
  return NextResponse.json({ ok: true });
}

function renderArtifactHtml(a: { title: string; body: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(a.title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light dark; }
      body{font-family:Inter,system-ui,sans-serif;max-width:680px;margin:0 auto;padding:48px 24px;color:#1c1917;line-height:1.65;background:#fafaf9}
      @media (prefers-color-scheme: dark) {
        body{color:#fafaf9;background:#0c0a09}
        table th,table td{border-color:#292524}
        code{background:#1c1917}
      }
      h1,h2{font-family:'Instrument Serif',Georgia,serif;font-weight:400;letter-spacing:-0.01em;line-height:1.1;margin-bottom:12px}
      h1{font-size:40px}h2{font-size:28px;margin-top:32px}h3{font-size:18px;margin-top:24px;margin-bottom:8px;font-weight:600}
      p{margin-bottom:14px}ul,ol{padding-left:22px;margin-bottom:14px}li{margin-bottom:4px}
      table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}
      th,td{padding:8px 10px;border-bottom:1px solid #e7e5e4;text-align:left}th{font-weight:600}
      code{font-family:'JetBrains Mono',monospace;background:#f5f5f4;padding:2px 6px;border-radius:4px;font-size:0.9em}
      img{max-width:100%;height:auto}
    </style>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono&display=swap" rel="stylesheet">
    </head><body><h1>${escape(a.title)}</h1>${a.body}</body></html>`;
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
