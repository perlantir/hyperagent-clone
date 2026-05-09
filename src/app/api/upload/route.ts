// File upload — accepts multipart/form-data.
//
// Two modes:
//
//   1. attachToMessage=true (P31): returns the file as an attachment object
//      that the client passes back via /api/chat. Image data URLs are inlined
//      so the chat route can translate them into Anthropic image content
//      blocks. Files (PDF, CSV) become text-preview attachments. No
//      message or artifact is created here — the chat route owns that.
//
//   2. Default mode: stores the file as an artifact + creates a user
//      message announcing the upload. Used by drag/drop on the empty
//      thread state and any other one-shot upload flow.
//
// Hard size limits applied per-mode to keep lambda payload + DB row sizes
// reasonable. Images up to 5 MB inline; over that, fall back to artifact.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createArtifact, createMessage, getThread, updateThread } from "@/lib/db";
import type { MessageAttachment } from "@/lib/types";
import { redactSecrets } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 60;

// 5 MB inline cap for images. Larger images become artifacts.
const INLINE_IMAGE_MAX = 5 * 1024 * 1024;
// 25 MB hard cap on any single upload, regardless of mode.
const HARD_UPLOAD_MAX = 25 * 1024 * 1024;
// First 8 KB of a CSV / PDF text extract is the preview the model sees.
const TEXT_PREVIEW_BYTES = 8 * 1024;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const fd = await req.formData();
  const threadId = String(fd.get("threadId") || "");
  const file = fd.get("file") as File | null;
  const attachToMessage = fd.get("attachToMessage") === "1";
  if (!threadId || !file) return NextResponse.json({ error: "threadId + file required" }, { status: 400 });
  if (file.size > HARD_UPLOAD_MAX) {
    return NextResponse.json({ error: `file exceeds ${(HARD_UPLOAD_MAX / 1024 / 1024).toFixed(0)} MB upload limit` }, { status: 413 });
  }

  const thread = await getThread(threadId, user.id);
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  const buf = Buffer.from(await file.arrayBuffer());
  const isImage = file.type.startsWith("image/");
  const isText = file.type.startsWith("text/") || file.type === "application/json" || /\.(md|txt|csv|json|tsv|log)$/i.test(file.name);

  // ====== Mode 1: attach-to-message (P31) ======
  if (attachToMessage) {
    if (isImage) {
      if (buf.length > INLINE_IMAGE_MAX) {
        return NextResponse.json({ error: `image exceeds ${(INLINE_IMAGE_MAX / 1024 / 1024).toFixed(0)} MB inline limit; use the artifact upload instead` }, { status: 413 });
      }
      const dataUrl = `data:${file.type};base64,${buf.toString("base64")}`;
      const att: MessageAttachment = {
        kind: "image",
        name: file.name,
        contentType: file.type,
        size: buf.length,
        dataUrl,
      };
      return NextResponse.json({ attachment: att });
    }

    if (isText) {
      const text = buf.toString("utf-8");
      const rawPreview = text.slice(0, TEXT_PREVIEW_BYTES);
      // P33b — strip API keys / secrets from the preview before persistence.
      // A user pasting a config file shouldn't unwittingly send their
      // production secrets to the model; the redactor leaves a [REDACTED:provider]
      // marker so the model still understands the file's structure.
      const preview = redactSecrets(rawPreview);
      const att: MessageAttachment = {
        kind: "file",
        name: file.name,
        contentType: file.type || "text/plain",
        size: buf.length,
        textPreview: preview,
      };
      return NextResponse.json({ attachment: att });
    }

    // Unsupported MIME for inline attach — return a clear error so the UI
    // can fall back to the artifact-upload mode instead of silently
    // succeeding with an attachment the model can't read.
    return NextResponse.json({
      error: "only images and text-like files (csv/md/txt/json) can be attached to messages",
      hint: "Drop this file directly into the thread to store it as an artifact instead.",
    }, { status: 415 });
  }

  // ====== Mode 2: artifact upload (legacy / fallback) ======
  const base64 = buf.toString("base64");

  const msg = await createMessage({
    threadId, role: "user",
    content: `[Uploaded file: ${file.name} (${file.type}, ${(buf.length/1024).toFixed(1)} KB)]`,
  });

  let artifactType: "image"|"document"|"webpage"|"table" = "document";
  let body = "";

  if (isImage) {
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
