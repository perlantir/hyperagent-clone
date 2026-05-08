// File upload — accepts multipart/form-data, stores files as artifacts.
// For text-y files (md/txt/json/csv) we store the text directly. For binary
// (images/PDFs/audio/video) we base64-encode and embed in an artifact body.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createArtifact, createMessage, getThread, updateThread } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const fd = await req.formData();
  const threadId = String(fd.get("threadId") || "");
  const file = fd.get("file") as File | null;
  if (!threadId || !file) return NextResponse.json({ error: "threadId + file required" }, { status: 400 });

  const thread = await getThread(threadId, user.id);
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  const buf = Buffer.from(await file.arrayBuffer());
  const isText = file.type.startsWith("text/") || file.type === "application/json" || /\.(md|txt|csv|json|tsv)$/i.test(file.name);
  const base64 = buf.toString("base64");

  // Create a system message that records the upload
  const msg = await createMessage({
    threadId, role: "user",
    content: `[Uploaded file: ${file.name} (${file.type}, ${(buf.length/1024).toFixed(1)} KB)]`,
  });

  let artifactType: "image"|"document"|"webpage"|"table" = "document";
  let body = "";

  if (file.type.startsWith("image/")) {
    artifactType = "image";
    body = `<img src="data:${file.type};base64,${base64}" style="max-width:100%;display:block">`;
  } else if (isText) {
    artifactType = "document";
    body = `<pre style="white-space:pre-wrap;font-family:JetBrains Mono,monospace;font-size:13px">${escapeHtml(buf.toString("utf-8").slice(0, 100000))}</pre>`;
  } else if (file.type === "application/pdf") {
    artifactType = "document";
    body = `<embed src="data:application/pdf;base64,${base64}" type="application/pdf" width="100%" height="800px">`;
  } else {
    artifactType = "document";
    body = `<p>Binary file: <strong>${escapeHtml(file.name)}</strong> (${file.type}, ${buf.length} bytes).</p><p>Size too large to inline; stored as base64 reference.</p>`;
  }

  const a = await createArtifact({
    threadId, messageId: msg.id, type: artifactType, title: file.name, body,
  });
  await updateThread(threadId, user.id, {});

  return NextResponse.json({
    ok: true,
    artifact: { id: a.id, title: a.title, type: a.type },
    message: { id: msg.id },
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c] as string));
}
