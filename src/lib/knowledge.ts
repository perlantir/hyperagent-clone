// P40 — Knowledge subsystem.
//
// Per-agent knowledge documents: a user uploads a doc (or pastes text),
// the system chunks it into ~400-token slices, embeds each chunk, stores
// chunks + embeddings on the agent. At run-time, the chat route fetches
// the top-K chunks most similar to the user's message and injects them
// as a new prompt segment.
//
// Mirrors the memory pipeline at the document-chunk granularity. Reuses
// embedText + cosineSimilarity. JS-side cosine is fine until users have
// thousands of docs (then we'd add pgvector).
//
// Tables:
//   agent_knowledge_docs (id, userId, agentId, title, content, sourceUrl, createdAt, updatedAt, byteSize)
//   agent_knowledge_chunks (id, docId, chunkIdx, content, embedding, tokens, createdAt)

import crypto from "node:crypto";
import { pool } from "./db";
import { embedText, cosineSimilarity } from "./embeddings";

let _initialized = false;
async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS agent_knowledge_docs (
      id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "agentId" TEXT REFERENCES agents(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      "sourceUrl" TEXT,
      "byteSize" INTEGER NOT NULL DEFAULT 0,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_knowledge_docs_agent
      ON agent_knowledge_docs("agentId", "createdAt" DESC);

    CREATE TABLE IF NOT EXISTS agent_knowledge_chunks (
      id TEXT PRIMARY KEY,
      "docId" TEXT NOT NULL REFERENCES agent_knowledge_docs(id) ON DELETE CASCADE,
      "chunkIdx" INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding JSONB,
      tokens INTEGER,
      "createdAt" BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_knowledge_chunks_doc
      ON agent_knowledge_chunks("docId", "chunkIdx");
  `);
  _initialized = true;
}

// ============ Chunking ============

const CHUNK_TARGET_CHARS = 1600; // ~400 tokens
const CHUNK_OVERLAP = 200;       // overlap between adjacent chunks

// Simple recursive-ish chunker: prefer paragraph boundaries, then sentence,
// then hard char-count. Overlap helps retrieve context even when a query
// straddles a chunk boundary.
export function chunkText(text: string): string[] {
  const t = text.trim();
  if (t.length <= CHUNK_TARGET_CHARS) return [t];
  const chunks: string[] = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(t.length, i + CHUNK_TARGET_CHARS);
    if (end < t.length) {
      // Try to end on a paragraph break first.
      const para = t.lastIndexOf("\n\n", end);
      if (para > i + CHUNK_TARGET_CHARS / 2) end = para;
      else {
        // Fall back to sentence break.
        const sent = t.lastIndexOf(". ", end);
        if (sent > i + CHUNK_TARGET_CHARS / 2) end = sent + 1;
      }
    }
    chunks.push(t.slice(i, end).trim());
    if (end >= t.length) break;
    i = end - CHUNK_OVERLAP;
    if (i < 0) i = 0;
  }
  return chunks.filter(c => c.length > 0);
}

// ============ Doc CRUD ============

export interface KnowledgeDoc {
  id: string;
  userId: string;
  agentId: string | null;
  title: string;
  content: string;
  sourceUrl: string | null;
  byteSize: number;
  createdAt: number;
  updatedAt: number;
  chunkCount?: number;
}

export async function createKnowledgeDoc(input: {
  userId: string; agentId: string | null;
  title: string; content: string; sourceUrl?: string | null;
}): Promise<{ doc: KnowledgeDoc; chunkCount: number }> {
  await ensureSchema();
  const id = "kd_" + crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  const byteSize = Buffer.byteLength(input.content, "utf-8");
  await pool().query(
    `INSERT INTO agent_knowledge_docs (id, "userId", "agentId", title, content, "sourceUrl", "byteSize", "createdAt", "updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
    [id, input.userId, input.agentId, input.title.slice(0, 200), input.content, input.sourceUrl || null, byteSize, now],
  );

  // Chunk + embed in the background-but-awaited path so the upload returns
  // with chunks ready. For very long docs (>50 chunks) this could be slow;
  // we cap chunk count at 100 to bound the embed cost per upload.
  const chunks = chunkText(input.content).slice(0, 100);
  if (chunks.length > 0) {
    // Embed sequentially to keep memory predictable. Each call is ~50ms.
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];
      let embedding: number[] | null = null;
      try { embedding = await embedText(chunk, input.userId); }
      catch (e) { console.error("[knowledge embed]", e); }
      const chunkId = "kc_" + crypto.randomBytes(8).toString("hex");
      await pool().query(
        `INSERT INTO agent_knowledge_chunks (id, "docId", "chunkIdx", content, embedding, tokens, "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [chunkId, id, idx, chunk, embedding ? JSON.stringify(embedding) : null, Math.ceil(chunk.length / 4), now],
      );
    }
  }

  const doc = await getKnowledgeDoc(id);
  return { doc: doc!, chunkCount: chunks.length };
}

export async function getKnowledgeDoc(id: string): Promise<KnowledgeDoc | null> {
  await ensureSchema();
  const r = await pool().query(`SELECT * FROM agent_knowledge_docs WHERE id=$1`, [id]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    id: row.id, userId: row.userId, agentId: row.agentId,
    title: row.title, content: row.content, sourceUrl: row.sourceUrl,
    byteSize: row.byteSize, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
  };
}

export async function listKnowledgeDocs(userId: string, agentId: string | null): Promise<KnowledgeDoc[]> {
  await ensureSchema();
  const conds: string[] = [`d."userId" = $1`];
  const vals: any[] = [userId];
  if (agentId !== undefined) {
    if (agentId === null) conds.push(`d."agentId" IS NULL`);
    else { vals.push(agentId); conds.push(`d."agentId" = $${vals.length}`); }
  }
  const r = await pool().query(
    `SELECT d.*, (SELECT COUNT(*)::int FROM agent_knowledge_chunks c WHERE c."docId" = d.id) AS chunk_count
     FROM agent_knowledge_docs d
     WHERE ${conds.join(" AND ")}
     ORDER BY d."createdAt" DESC`,
    vals,
  );
  return r.rows.map((row: any) => ({
    id: row.id, userId: row.userId, agentId: row.agentId,
    title: row.title, content: "", // never returned from list
    sourceUrl: row.sourceUrl, byteSize: row.byteSize,
    createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
    chunkCount: Number(row.chunk_count || 0),
  }));
}

export async function deleteKnowledgeDoc(id: string, userId: string): Promise<boolean> {
  await ensureSchema();
  const r = await pool().query(
    `DELETE FROM agent_knowledge_docs WHERE id=$1 AND "userId"=$2`,
    [id, userId],
  );
  return (r.rowCount || 0) > 0;
}

// ============ Retrieval ============

export interface RetrievedChunk {
  docId: string;
  docTitle: string;
  chunkIdx: number;
  content: string;
  similarity: number;
}

// Fetch the top-K most-similar chunks across all docs scoped to the agent
// (or all of the user's docs if agentId is null). Per-user, JS-side cosine.
//
// Cap total scanned chunks so a user with thousands of docs doesn't blow
// the chat lambda timeout. Pre-filter by recency before embedding compare.
const MAX_CHUNKS_SCANNED = 500;

export async function retrieveKnowledge(
  query: string,
  opts: { userId: string; agentId: string | null; topK?: number; threshold?: number } = { userId: "", agentId: null },
): Promise<RetrievedChunk[]> {
  await ensureSchema();
  const topK = opts.topK ?? 4;
  const threshold = opts.threshold ?? 0.5;

  // Embed the query once.
  let queryEmbedding: number[];
  try { queryEmbedding = await embedText(query, opts.userId); }
  catch { return []; }

  const conds: string[] = [`d."userId" = $1`];
  const vals: any[] = [opts.userId];
  if (opts.agentId === null) conds.push(`d."agentId" IS NULL`);
  else { vals.push(opts.agentId); conds.push(`d."agentId" = $${vals.length}`); }

  const r = await pool().query(
    `SELECT c.id, c."docId", c."chunkIdx", c.content, c.embedding, d.title AS "docTitle"
     FROM agent_knowledge_chunks c
     JOIN agent_knowledge_docs d ON d.id = c."docId"
     WHERE ${conds.join(" AND ")}
       AND c.embedding IS NOT NULL
     ORDER BY d."createdAt" DESC, c."chunkIdx" ASC
     LIMIT ${MAX_CHUNKS_SCANNED}`,
    vals,
  );

  const scored = r.rows.map((row: any) => {
    let emb: number[] = [];
    try { emb = JSON.parse(row.embedding); } catch { return null; }
    if (!Array.isArray(emb) || emb.length !== queryEmbedding.length) return null;
    return {
      docId: row.docId,
      docTitle: row.docTitle,
      chunkIdx: row.chunkIdx,
      content: row.content,
      similarity: cosineSimilarity(queryEmbedding, emb),
    };
  }).filter((x: any): x is RetrievedChunk => x !== null && x.similarity >= threshold);

  scored.sort((a: RetrievedChunk, b: RetrievedChunk) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}
