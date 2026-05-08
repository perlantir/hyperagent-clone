// API key management (P17). User creates and revokes their own keys.
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";

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
  await pool().query(
    `INSERT INTO api_keys (id, "userId", name, "keyHash", "keyPrefix", "lastUsedAt", "createdAt") VALUES ($1,$2,$3,$4,$5,NULL,$6)`,
    [id, user.id, name || "Untitled key", hash, prefix, Date.now()],
  );
  // raw key is returned ONCE — never stored in plaintext
  return NextResponse.json({ id, name: name || "Untitled key", key: raw, keyPrefix: prefix });
}
