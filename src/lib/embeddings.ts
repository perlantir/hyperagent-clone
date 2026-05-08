// P25 — text embeddings via OpenAI text-embedding-3-small.
//
// 1536-dim float vectors. ~$0.02/1M tokens — basically free for memory volumes.
// Per-user keys via resolveSecret; falls back to platform OPENAI_API_KEY.
//
// We store embeddings as JSONB float arrays in Postgres rather than using
// pgvector. Tradeoff: ~3× larger storage and slower similarity search vs.
// pgvector, but no extension dependency. For memory volumes where each user
// has hundreds-not-millions of memories, JS-side cosine after a scope-filtered
// SELECT is fine. If we hit volumes that justify pgvector (10k+ memories/user
// or org-level shared knowledge bases), the migration is mechanical.
//
// Embedding cache: in-memory LRU keyed by sha256(text), 5min TTL. Avoids
// re-embedding the same query repeatedly within a chat session.

import crypto from "node:crypto";
import { resolveSecret } from "./secrets";
export { cosineSimilarity } from "./cosine";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 1000;

interface CacheEntry { embedding: number[]; ts: number; }
const _cache = new Map<string, CacheEntry>();

function cacheKey(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function evictExpired() {
  const now = Date.now();
  for (const [key, entry] of _cache) {
    if (now - entry.ts > CACHE_TTL_MS) _cache.delete(key);
  }
  // LRU-ish: if still oversized, drop oldest entries
  while (_cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = _cache.keys().next().value;
    if (oldestKey) _cache.delete(oldestKey);
    else break;
  }
}

export async function embedText(text: string, userId: string | null = null): Promise<number[]> {
  if (!text || text.trim().length === 0) return new Array(EMBEDDING_DIMS).fill(0);

  const key = cacheKey(text);
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    cached.ts = Date.now(); // refresh LRU
    return cached.embedding;
  }

  const apiKey = await resolveSecret(userId, "openai");
  if (!apiKey) {
    throw new Error("OpenAI API key required for embeddings. Add one in Settings → API Keys.");
  }

  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      input: text.slice(0, 8000),  // model max is 8191 tokens; chars/4 leaves headroom
      model: EMBEDDING_MODEL,
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`OpenAI embeddings ${r.status}: ${err.slice(0, 300)}`);
  }
  const j = await r.json();
  const embedding: number[] = j?.data?.[0]?.embedding || new Array(EMBEDDING_DIMS).fill(0);

  _cache.set(key, { embedding, ts: Date.now() });
  evictExpired();

  return embedding;
}

export async function embedBatch(texts: string[], userId: string | null = null): Promise<number[][]> {
  if (!texts.length) return [];

  // Check cache first; only call API for misses
  const results: (number[] | null)[] = texts.map(() => null);
  const missingIndices: number[] = [];
  const missingTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const key = cacheKey(texts[i]);
    const cached = _cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      results[i] = cached.embedding;
    } else {
      missingIndices.push(i);
      missingTexts.push(texts[i].slice(0, 8000));
    }
  }
  if (missingTexts.length === 0) return results as number[][];

  const apiKey = await resolveSecret(userId, "openai");
  if (!apiKey) throw new Error("OpenAI API key required for embeddings.");

  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ input: missingTexts, model: EMBEDDING_MODEL }),
  });
  if (!r.ok) throw new Error(`OpenAI embeddings ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const newEmbeddings: number[][] = (j?.data || []).map((d: any) => d.embedding);

  for (let k = 0; k < missingIndices.length; k++) {
    const i = missingIndices[k];
    const emb = newEmbeddings[k] || new Array(EMBEDDING_DIMS).fill(0);
    results[i] = emb;
    _cache.set(cacheKey(texts[i]), { embedding: emb, ts: Date.now() });
  }
  evictExpired();
  return results as number[][];
}

// cosineSimilarity is re-exported from ./cosine (pure, no I/O deps so tests
// and client-side code can import it without dragging in pg).
