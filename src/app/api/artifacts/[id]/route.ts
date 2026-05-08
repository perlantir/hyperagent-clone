import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getArtifact, getThread, listArtifactsForUser } from "@/lib/db";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const a = await getArtifact(params.id);
  if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
  const thread = await getThread(a.threadId, user.id);
  if (!thread) return NextResponse.json({ error: "not found" }, { status: 404 });

  const url = new URL(req.url);
  if (url.searchParams.get("render") === "1") {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(a.title)}</title>
      <style>
        body{font-family:Inter,system-ui,sans-serif;max-width:680px;margin:0 auto;padding:48px 24px;color:#1c1917;line-height:1.65}
        h1,h2{font-family:'Instrument Serif',Georgia,serif;font-weight:400;letter-spacing:-0.01em;line-height:1.1;margin-bottom:12px}
        h1{font-size:40px}h2{font-size:28px;margin-top:32px}h3{font-size:18px;margin-top:24px;margin-bottom:8px;font-weight:600}
        p{margin-bottom:14px}ul,ol{padding-left:22px;margin-bottom:14px}li{margin-bottom:4px}
        table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}
        th,td{padding:8px 10px;border-bottom:1px solid #e7e5e4;text-align:left}th{font-weight:600}
        code{font-family:'JetBrains Mono',monospace;background:#f5f5f4;padding:2px 6px;border-radius:4px;font-size:0.9em}
      </style>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono&display=swap" rel="stylesheet">
      </head><body><h1>${escape(a.title)}</h1>${a.body}</body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return NextResponse.json({ artifact: a });
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
