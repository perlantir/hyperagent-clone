// P25 — Knowledge Base v2.
//
// Memory state machine with proposal-based writes, embedding-based retrieval,
// scope enforcement, dedup, PII detection, and three-tier surface:
//
//   T1 (always present): pinned + importance ≥ 8 — injected in every prompt
//   T2 (contextual): top-K cosine match against the user's current message
//   T3 (on-demand): search_knowledge tool the agent calls explicitly
//
// Write path is proposal-first: low-risk categories auto-accept, others queue
// for user approval. PII triggers automatic queue regardless of category.

import crypto from "node:crypto";
import { pool } from "./db";
import { embedText } from "./embeddings";
import { cosineSimilarity } from "./cosine";
import { detectPii } from "./security";
import { audit } from "./audit";
import type { Memory } from "./types";

export type MemoryState = "proposed" | "accepted" | "rejected" | "expired" | "superseded";

export type MemoryCategory =
  | "user_fact"            // stable facts about the user
  | "preference"           // their preferences
  | "project_context"      // facts about the current project
  | "domain_knowledge"     // subject-matter knowledge
  | "people"               // colleagues, contacts
  | "active_work"          // current projects/tasks
  | "tools_and_workflows"  // how they work
  | "organization";        // company-level info

// Categories that auto-accept on save (low-risk operational facts).
// Everything else requires explicit user approval.
const AUTO_ACCEPT_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
  "preference", "user_fact", "tools_and_workflows",
]);

const DEDUP_SIMILARITY_THRESHOLD = 0.95;
const MIN_QUERY_LENGTH = 8;  // skip embedding for trivial queries

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'accepted';
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS "whenToUse" TEXT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS tags JSONB;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 0.8;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS "piiFlag" BOOLEAN DEFAULT FALSE;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding JSONB;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS "embeddingHash" TEXT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS "lastUsedAt" BIGINT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS "decayScore" REAL DEFAULT 1.0;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS "sourceRunId" TEXT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS "retentionPolicy" TEXT DEFAULT 'permanent';
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;

    CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned) WHERE pinned = TRUE;
    CREATE INDEX IF NOT EXISTS idx_memories_user_state ON memories("userId", state, "createdAt" DESC);
  `);
  _initialized = true;
}

// =================== T1: ALWAYS-PRESENT MEMORIES ===================

export async function pinnedMemories(
  userId: string,
  agentId: string | null = null,
  projectId: string | null = null,
  limit: number = 8,
): Promise<Memory[]> {
  await ensureSchema();
  const r = await pool().query(`
    SELECT * FROM memories
    WHERE "userId"=$1
      AND state='accepted'
      AND (pinned = TRUE OR importance >= 8)
      AND ("agentId" IS NULL OR "agentId"=$2)
      AND ("projectId" IS NULL OR "projectId"=$3)
    ORDER BY pinned DESC, importance DESC, "createdAt" DESC
    LIMIT $4
  `, [userId, agentId, projectId, limit]);
  return r.rows;
}

// =================== T2: CONTEXTUAL RETRIEVAL ===================

export interface ContextualOptions {
  userId: string;
  agentId?: string | null;
  projectId?: string | null;
  query: string;
  topK?: number;
  minSimilarity?: number;
  excludeIds?: Set<string>;
}

export async function contextualMemories(opts: ContextualOptions): Promise<Memory[]> {
  await ensureSchema();
  const topK = opts.topK ?? 5;
  const minSim = opts.minSimilarity ?? 0.5;

  if (!opts.query || opts.query.trim().length < MIN_QUERY_LENGTH) return [];

  // Pull all candidates in scope. Excludes T1 (pinned + importance>=8) since
  // those are already injected. Reasonable cap on candidates — if a user has
  // 10k+ memories, they need pgvector and we'll add it.
  const r = await pool().query(`
    SELECT * FROM memories
    WHERE "userId"=$1
      AND state='accepted'
      AND embedding IS NOT NULL
      AND ("agentId" IS NULL OR "agentId"=$2)
      AND ("projectId" IS NULL OR "projectId"=$3)
      AND (importance < 8 AND (pinned IS NULL OR pinned = FALSE))
    ORDER BY "createdAt" DESC
    LIMIT 500
  `, [opts.userId, opts.agentId || null, opts.projectId || null]);

  if (!r.rows.length) return [];

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(opts.query, opts.userId);
  } catch {
    // Embedding failed (no key, network) — gracefully degrade by returning empty.
    // T1 still serves the always-present case; missing T2 just means no semantic match.
    return [];
  }

  const exclude = opts.excludeIds || new Set<string>();
  const scored = r.rows
    .filter(m => !exclude.has(m.id))
    .map(m => ({
      memory: m,
      similarity: cosineSimilarity(queryEmbedding, m.embedding || []),
    }))
    .filter(s => s.similarity >= minSim)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);

  // Update lastUsedAt (best-effort, fire-and-forget)
  if (scored.length > 0) {
    const ids = scored.map(s => s.memory.id);
    pool().query(
      `UPDATE memories SET "lastUsedAt"=$1 WHERE id = ANY($2::text[])`,
      [Date.now(), ids],
    ).catch(e => console.error("[memory lastUsedAt update]", e));
  }

  return scored.map(s => s.memory);
}

// =================== T3: AGENT-DRIVEN SEARCH ===================

export interface SearchOptions {
  agentId?: string | null;
  projectId?: string | null;
  limit?: number;
  minSimilarity?: number;
  includeProposed?: boolean;
}

export interface SearchHit extends Memory {
  similarity: number;
}

export async function searchKnowledge(
  userId: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  await ensureSchema();
  const limit = opts.limit ?? 20;
  const minSim = opts.minSimilarity ?? 0.4;

  const stateClause = opts.includeProposed
    ? `state IN ('accepted', 'proposed')`
    : `state = 'accepted'`;

  const r = await pool().query(`
    SELECT * FROM memories
    WHERE "userId"=$1
      AND ${stateClause}
      AND embedding IS NOT NULL
      AND ("agentId" IS NULL OR "agentId"=$2)
      AND ("projectId" IS NULL OR "projectId"=$3)
    ORDER BY "createdAt" DESC
    LIMIT 1000
  `, [userId, opts.agentId || null, opts.projectId || null]);

  if (!r.rows.length) return [];

  const queryEmbedding = await embedText(query, userId);

  return r.rows
    .map(m => ({ ...m, similarity: cosineSimilarity(queryEmbedding, m.embedding || []) }))
    .filter(s => s.similarity >= minSim)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

// =================== WRITE PATH (PROPOSAL-BASED) ===================

export interface ProposeMemoryInput {
  userId: string;
  content: string;
  agentId?: string | null;
  projectId?: string | null;
  category?: MemoryCategory;
  whenToUse?: string;
  tags?: string[];
  importance?: number;     // 0-10
  pinned?: boolean;
  sourceRunId?: string;
  forceState?: MemoryState;
}

export interface ProposeMemoryResult {
  memoryId: string;
  state: MemoryState;
  reason: string;
  duplicateOfId?: string;
  piiDetected?: boolean;
  piiTypes?: string[];
}

export async function proposeMemory(input: ProposeMemoryInput): Promise<ProposeMemoryResult> {
  await ensureSchema();

  // Step 1: PII detection
  const piiCheck = detectPii(input.content);

  // Step 2: Determine state
  let state: MemoryState;
  if (input.forceState) {
    state = input.forceState;
  } else if (piiCheck.hasPii) {
    state = "proposed"; // PII always requires explicit approval
  } else if (input.category && AUTO_ACCEPT_CATEGORIES.has(input.category)) {
    state = "accepted";
  } else {
    state = "proposed";
  }

  // Step 3: Generate embedding for accepted memories so they can be retrieved.
  // Proposed memories get embedded only after acceptance.
  let embedding: number[] | null = null;
  let embeddingHash: string | null = null;
  if (state === "accepted") {
    try {
      embedding = await embedText(input.content, input.userId);
      embeddingHash = hashEmbedding(embedding);
    } catch (e) {
      console.error("[proposeMemory] embedding failed:", e);
      // Save anyway; embedding can be backfilled later
    }
  }

  // Step 4: Dedup check (only for accepted with embeddings)
  if (state === "accepted" && embedding) {
    const existing = await pool().query(`
      SELECT id, embedding FROM memories
      WHERE "userId"=$1 AND state='accepted' AND embedding IS NOT NULL
        AND ("agentId" IS NULL OR "agentId"=$2)
        AND ("projectId" IS NULL OR "projectId"=$3)
      ORDER BY "createdAt" DESC
      LIMIT 200
    `, [input.userId, input.agentId || null, input.projectId || null]);

    for (const m of existing.rows) {
      const sim = cosineSimilarity(embedding, m.embedding || []);
      if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
        await pool().query(
          `UPDATE memories SET "lastUsedAt"=$1 WHERE id=$2`,
          [Date.now(), m.id],
        );
        await audit({
          userId: input.userId, action: "memory.write", resource: `memory:${m.id}`,
          result: "success", metadata: { dedup: true, similarity: sim, sourceRunId: input.sourceRunId },
        });
        return {
          memoryId: m.id, state: "accepted",
          reason: `Deduplicated against existing memory (similarity ${sim.toFixed(3)})`,
          duplicateOfId: m.id, piiDetected: piiCheck.hasPii, piiTypes: piiCheck.types,
        };
      }
    }
  }

  // Step 5: Insert
  const id = "mem_" + crypto.randomBytes(8).toString("hex");
  const createdAt = Date.now();
  await pool().query(`
    INSERT INTO memories (
      id, "userId", "agentId", "projectId", content, importance,
      state, category, "whenToUse", tags, "piiFlag", embedding, "embeddingHash",
      "sourceRunId", pinned, "createdAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  `, [
    id, input.userId, input.agentId || null, input.projectId || null,
    input.content, input.importance ?? 5,
    state, input.category || null, input.whenToUse || null,
    input.tags ? JSON.stringify(input.tags) : null,
    piiCheck.hasPii,
    embedding ? JSON.stringify(embedding) : null,
    embeddingHash,
    input.sourceRunId || null,
    input.pinned || false,
    createdAt,
  ]);

  await audit({
    userId: input.userId, action: "memory.write", resource: `memory:${id}`,
    result: "success",
    metadata: {
      state, category: input.category, piiDetected: piiCheck.hasPii,
      piiTypes: piiCheck.types, sourceRunId: input.sourceRunId,
    },
  });
  if (piiCheck.hasPii) {
    await audit({
      userId: input.userId, action: "memory.read_pii", resource: `memory:${id}`,
      result: "success", metadata: { types: piiCheck.types, count: piiCheck.count },
    });
  }

  return {
    memoryId: id, state,
    reason: state === "accepted"
      ? "Auto-accepted (low-risk category, no PII)"
      : piiCheck.hasPii
        ? `Queued for review (PII detected: ${piiCheck.types.join(", ")})`
        : "Queued for review (requires user approval)",
    piiDetected: piiCheck.hasPii, piiTypes: piiCheck.types,
  };
}

export async function acceptMemory(memoryId: string, userId: string): Promise<{ ok: boolean; reason?: string }> {
  await ensureSchema();
  const r = await pool().query(
    `SELECT content, state, embedding FROM memories WHERE id=$1 AND "userId"=$2`,
    [memoryId, userId],
  );
  if (!r.rows[0]) return { ok: false, reason: "memory not found" };
  if (r.rows[0].state === "accepted") return { ok: true, reason: "already accepted" };

  // Generate embedding now that it's being accepted
  let embedding = r.rows[0].embedding;
  if (!embedding) {
    try {
      const emb = await embedText(r.rows[0].content, userId);
      embedding = JSON.stringify(emb);
    } catch (e) {
      console.error("[acceptMemory] embedding failed:", e);
    }
  }

  await pool().query(
    `UPDATE memories SET state='accepted', embedding=$3 WHERE id=$1 AND "userId"=$2`,
    [memoryId, userId, embedding],
  );
  await audit({
    userId, action: "memory.write", resource: `memory:${memoryId}`,
    result: "success", metadata: { transition: "proposed→accepted" },
  });
  return { ok: true };
}

export async function rejectMemory(memoryId: string, userId: string): Promise<{ ok: boolean }> {
  await ensureSchema();
  await pool().query(
    `UPDATE memories SET state='rejected' WHERE id=$1 AND "userId"=$2`,
    [memoryId, userId],
  );
  await audit({
    userId, action: "memory.write", resource: `memory:${memoryId}`,
    result: "success", metadata: { transition: "→rejected" },
  });
  return { ok: true };
}

export async function pinMemory(memoryId: string, userId: string, pinned: boolean): Promise<{ ok: boolean }> {
  await ensureSchema();
  await pool().query(
    `UPDATE memories SET pinned=$3 WHERE id=$1 AND "userId"=$2`,
    [memoryId, userId, pinned],
  );
  return { ok: true };
}

export async function listMemoriesByState(
  userId: string,
  state: MemoryState | "all" = "all",
  limit = 100,
): Promise<Memory[]> {
  await ensureSchema();
  const stateClause = state === "all" ? "" : ` AND state=$3`;
  const params: any[] = [userId, limit];
  if (state !== "all") params.push(state);
  const r = await pool().query(
    `SELECT * FROM memories WHERE "userId"=$1${stateClause} ORDER BY "createdAt" DESC LIMIT $2`,
    params,
  );
  return r.rows;
}

function hashEmbedding(emb: number[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(emb)).digest("hex").slice(0, 16);
}

// =================== ORCHESTRATOR (BACKWARD COMPAT + T1+T2 MERGE) ===================

export interface MemoryRetrievalResult {
  pinned: Memory[];
  contextual: Memory[];
}

// Returns T1 + T2 separately so the prompt compiler can place them in
// distinct segments. Caller should pass the user's current message as `query`
// to enable T2 contextual retrieval. If no query is provided, only T1 returns.
export async function retrieveMemoriesForChat(
  userId: string,
  agentId: string | null,
  projectId: string | null,
  query: string,
): Promise<MemoryRetrievalResult> {
  const pinned = await pinnedMemories(userId, agentId, projectId, 8);
  const pinnedIds = new Set(pinned.map(m => m.id));

  let contextual: Memory[] = [];
  if (query && query.trim().length >= MIN_QUERY_LENGTH) {
    try {
      contextual = await contextualMemories({
        userId, agentId, projectId, query, topK: 5, excludeIds: pinnedIds,
      });
    } catch (e) {
      console.error("[retrieveMemoriesForChat] T2 failed, degrading to T1-only:", e);
    }
  }

  return { pinned, contextual };
}

// Backward-compat: existing callers expect a flat Memory[]. Keep working by
// merging T1+T2 with stable ordering.
export async function memoriesForContext(
  userId: string,
  agentId: string | null,
  projectId: string | null,
  query?: string,
): Promise<Memory[]> {
  const { pinned, contextual } = await retrieveMemoriesForChat(userId, agentId, projectId, query || "");
  const seen = new Set<string>();
  const merged: Memory[] = [];
  for (const m of [...pinned, ...contextual]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
    if (merged.length >= 12) break;
  }
  return merged;
}

// Legacy helper kept so older call sites compile. The prompt compiler already
// has memory_pinned + memory_contextual segment builders; this string version
// is only used by routes that haven't migrated yet (slack-handler used to;
// it now uses composeSystemPrompt).
export function memoriesAsSystemBlock(memories: Memory[]): string {
  if (!memories.length) return "";
  const formatted = memories.map(m => `- ${m.content}`).join("\n");
  return `\n\n# Memories about the user\n${formatted}\n`;
}
