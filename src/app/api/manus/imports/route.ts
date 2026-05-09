// P63 — Manus import endpoint.
//
//   GET    /api/manus/imports  → list past imports (history)
//   POST   /api/manus/imports  → upload a Manus export (.json or .zip)
//   DELETE /api/manus/imports  → clear import history (does NOT delete imported rows)

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { importManusExport, listImports, clearImportHistory } from "@/lib/manus-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ imports: await listImports(user.id) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const fd = await req.formData().catch(() => null);
  if (!fd) return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  const file = fd.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `File exceeds ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB limit.` }, { status: 413 });
  }

  // Read the file bytes. We accept a raw .json or a .zip with one .json inside.
  const buf = Buffer.from(await file.arrayBuffer());
  let jsonText: string;
  try {
    if (file.name.toLowerCase().endsWith(".zip") || isZipMagic(buf)) {
      jsonText = await extractFirstJsonFromZip(buf);
    } else {
      jsonText = buf.toString("utf-8");
    }
  } catch (e: any) {
    return NextResponse.json({ error: `Could not read file: ${e?.message || e}` }, { status: 400 });
  }

  let data: any;
  try { data = JSON.parse(jsonText); }
  catch (e: any) { return NextResponse.json({ error: `Not valid JSON: ${e?.message || e}` }, { status: 400 }); }

  // Tolerate two shapes: top-level { threads, agents, memories } OR
  // a wrapper like { data: { ... } } that some Manus exports use.
  const root = data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : data;
  if (!root || typeof root !== "object") {
    return NextResponse.json({ error: "Export root must be a JSON object." }, { status: 400 });
  }

  const summary = await importManusExport(user.id, file.name, root);
  return NextResponse.json(summary);
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await clearImportHistory(user.id);
  return NextResponse.json({ ok: true });
}

// ─── zip helper (lazy require so we don't bloat the lambda when JSON-only) ──

function isZipMagic(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

/**
 * Extract the first .json file from a zip. We rely on Node's built-in
 * zlib for inflate; the zip parser here is intentionally minimal —
 * just enough to walk the central directory and inflate the first
 * .json entry. No external deps.
 */
async function extractFirstJsonFromZip(buf: Buffer): Promise<string> {
  const zlib = await import("node:zlib");
  // Locate end-of-central-directory record (signature 0x06054b50).
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error("Not a valid zip (no EOCD record)");
  const cdOff = buf.readUInt32LE(eocdOff + 16);
  const cdEntries = buf.readUInt16LE(eocdOff + 10);
  let p = cdOff;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad central-directory header");
    const compMethod = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localHeaderOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf-8");
    p += 46 + nameLen + extraLen + cmtLen;
    if (!name.toLowerCase().endsWith(".json")) continue;

    // Read the local file header to find the data offset.
    if (buf.readUInt32LE(localHeaderOff) !== 0x04034b50) throw new Error("Bad local header");
    const lhNameLen = buf.readUInt16LE(localHeaderOff + 26);
    const lhExtraLen = buf.readUInt16LE(localHeaderOff + 28);
    const dataStart = localHeaderOff + 30 + lhNameLen + lhExtraLen;
    const dataEnd = dataStart + compSize;
    const data = buf.subarray(dataStart, dataEnd);

    if (compMethod === 0) return data.toString("utf-8"); // stored, no compression
    if (compMethod === 8) {
      // deflate (raw, no zlib header)
      return await new Promise<string>((resolve, reject) => {
        zlib.inflateRaw(data, (err, out) => err ? reject(err) : resolve(out.toString("utf-8")));
      });
    }
    throw new Error(`Unsupported zip compression method: ${compMethod}`);
  }
  throw new Error("Zip contains no .json file");
}
