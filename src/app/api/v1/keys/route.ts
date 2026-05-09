// API key management (P17 + P35). User creates and revokes their own keys.
//
// Keys are stored as SHA-256 hashes; the raw key is returned ONCE at create
// time and never persisted. The keyPrefix lets the UI display "hak_xxx…"
// without revealing the rest. lastUsedAt is bumped on every successful
// authenticated call to /api/v1/chat or /api/v1/agents/{id}/invoke.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { audit, auditFromRequest } from "@/lib/audit";

async function ensureKeyTable() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, "keyHash" TEXT NOT NULL UNIQUE, "keyPrefix" TEXT NOT NULL,
      "lastUsedAt" BIGINT, "createdAt" BIGINT NOT NULL
    );
  `);
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureKeyTable();
  const r = await pool().query(`SELECT id, name, "keyPrefix", "lastUsedAt", "createdAt" FROM api_keys WHERE "userId"=$1 ORDER BY "createdAt" DESC`, [user.id]);
  return NextResponse.json({ keys: r.rows });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureKeyTable();
  const { name } = await req.json().catch(() => ({}));
  const raw = `hak_${crypto.randomBytes(24).toString("base64url")}`;
  const id = `key_${crypto.randomBytes(8).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12) + "…";
  const finalName = name || "Untitled key";
  await pool().query(
    `INSERT INTO api_keys (id, "userId", name, "keyHash", "keyPrefix", "lastUsedAt", "createdAt") VALUES ($1,$2,$3,$4,$5,NULL,$6)`,
    [id, user.id, finalName, hash, prefix, Date.now()],
  );
  // P35 — audit the creation. Metadata captures name + prefix so a later
  // operator review can correlate revocations against the original create.
  // Raw key is NEVER logged.
  await audit({
    userId: user.id, action: "api_key.create", resource: id,
    result: "success", metadata: { name: finalName, keyPrefix: prefix },
    ...auditFromRequest(req),
  });
  return NextResponse.json({ id, name: finalName, key: raw, keyPrefix: prefix });
}
