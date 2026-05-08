// P25b — Memory compaction.
//
// Periodically scan accepted memories for high-similarity pairs (cosine 0.85-0.94)
// — above "different memories about related topics" but below the 0.95 dedup
// threshold that's already merged at insert time. For each candidate pair,
// ask an LLM judge: are these redundant? If yes, propose a merged version.
//
// User reviews proposals in /learning and one-click accepts the merge.
// Compacted memories are marked state='superseded' and replaced by the
// merged memory.
//
// Decay scoring: decayScore = importance × 0.85^(days_since_used / 30).
// Memories that haven't been retrieved in 90+ days score notably lower in
// T2 contextual ranking, naturally fading without being deleted.

import crypto from "node:crypto";
import { pool } from "./db";
import { cosineSimilarity } from "./cosine";
import { embedText } from "./embeddings";
import { clientForUser, DEFAULT_MODEL } from "./llm";
import { withRetry } from "./providers";

const COMPACTION_MIN_SIM = 0.85;
const COMPACTION_MAX_SIM = 0.94;  // 0.95+ already deduped at insert time
const COMPACTION_BATCH_SIZE = 50;
const COMPACTION_MAX_PAIRS_PER_RUN = 20;

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS memory_compaction_proposals (
      id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "memoryAId" TEXT NOT NULL,
      "memoryBId" TEXT NOT NULL,
      similarity REAL NOT NULL,
      "mergedContent" TEXT NOT NULL,
      "mergedCategory" TEXT,
      "mergedImportance" INTEGER,
      reasoning TEXT,
      status TEXT DEFAULT 'pending',     -- pending | accepted | rejected | superseded
      "createdAt" BIGINT NOT NULL,
      "resolvedAt" BIGINT,
      UNIQUE("memoryAId", "memoryBId")
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_user_status ON memory_compaction_proposals("userId", status, "createdAt" DESC);
  `);
  _initialized = true;
}

// Find candidate pairs by cosine similarity. Pure scan over user's accepted
// memories — for the volumes we expect (hundreds per user) this is cheap.
// At 10k+ memories per user we'd switch to pgvector + nearest-neighbor index.
export async function findCompactionCandidates(userId: string): Promise<Array<{ a: any; b: any; similarity: number }>> {
  await ensureSchema();
  const r = await pool().query(`
    SELECT id, content, embedding, category, importance, "createdAt"
    FROM memories
    WHERE "userId"=$1 AND state='accepted' AND embedding IS NOT NULL
    ORDER BY "createdAt" ASC
    LIMIT $2
  `, [userId, COMPACTION_BATCH_SIZE]);

  const rows = r.rows.filter(m => Array.isArray(m.embedding) && m.embedding.length > 0);
  const candidates: Array<{ a: any; b: any; similarity: number }> = [];

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sim = cosineSimilarity(rows[i].embedding, rows[j].embedding);
      if (sim >= COMPACTION_MIN_SIM && sim < COMPACTION_MAX_SIM) {
        candidates.push({ a: rows[i], b: rows[j], similarity: sim });
      }
    }
  }

  // Sort by similarity desc; take top N to avoid LLM-budget explosion
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, COMPACTION_MAX_PAIRS_PER_RUN);
}

const JUDGE_PROMPT = `You are evaluating whether two stored memories are redundant. If they describe the same fact/preference/context (even with different wording), they should be merged. If they describe distinct things (even if related), keep them separate.

Return JSON only:
{
  "redundant": true|false,
  "reasoning": "<1-2 sentences>",
  "mergedContent": "<single declarative sentence preserving all info from both, or null if not redundant>"
}`;

// Ask the LLM if a candidate pair is genuinely redundant. Returns merge proposal
// if so, null if memories are actually distinct.
export async function judgeMemoryPair(
  userId: string,
  a: { content: string },
  b: { content: string },
): Promise<{ redundant: boolean; reasoning: string; mergedContent: string | null }> {
  const ant = await clientForUser(userId);
  const result = await withRetry(
    () => ant.messages.create({
      model: "claude-haiku-4-5-20250929",
      max_tokens: 300,
      system: JUDGE_PROMPT,
      messages: [{
        role: "user",
        content: `Memory A: "${a.content}"\nMemory B: "${b.content}"\n\nAre these redundant? JSON only.`,
      }],
    }),
    { maxAttempts: 2 },
  );

  let text = "";
  for (const block of result.content) if (block.type === "text") text += (block as any).text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { redundant: false, reasoning: "judge returned no JSON", mergedContent: null };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      redundant: !!parsed.redundant,
      reasoning: String(parsed.reasoning || "").slice(0, 500),
      mergedContent: parsed.mergedContent ? String(parsed.mergedContent).slice(0, 1000) : null,
    };
  } catch {
    return { redundant: false, reasoning: "judge JSON unparseable", mergedContent: null };
  }
}

// Generate compaction proposals for a user. Idempotent: rows are uniqued on
// (memoryAId, memoryBId) so re-running won't duplicate.
export async function generateCompactionProposals(userId: string): Promise<{ scanned: number; proposals: number; pairs: number }> {
  await ensureSchema();
  const candidates = await findCompactionCandidates(userId);
  if (!candidates.length) return { scanned: 0, proposals: 0, pairs: 0 };

  let proposalsCreated = 0;
  for (const { a, b, similarity } of candidates) {
    // Skip if proposal already exists
    const exists = await pool().query(
      `SELECT id FROM memory_compaction_proposals WHERE ("memoryAId"=$1 AND "memoryBId"=$2) OR ("memoryAId"=$2 AND "memoryBId"=$1)`,
      [a.id, b.id],
    );
    if (exists.rows[0]) continue;

    let judged: { redundant: boolean; reasoning: string; mergedContent: string | null };
    try {
      judged = await judgeMemoryPair(userId, a, b);
    } catch (err) {
      console.error("[memory-compaction judge]", err);
      continue;
    }

    if (!judged.redundant || !judged.mergedContent) continue;

    const id = "cmp_" + crypto.randomBytes(8).toString("hex");
    await pool().query(`
      INSERT INTO memory_compaction_proposals
        (id, "userId", "memoryAId", "memoryBId", similarity, "mergedContent",
         "mergedCategory", "mergedImportance", reasoning, "createdAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT ("memoryAId", "memoryBId") DO NOTHING
    `, [
      id, userId, a.id, b.id, similarity, judged.mergedContent,
      a.category || b.category || null,
      Math.max(a.importance || 5, b.importance || 5),
      judged.reasoning,
      Date.now(),
    ]);
    proposalsCreated++;
  }
  return { scanned: candidates.length * 2, pairs: candidates.length, proposals: proposalsCreated };
}

// Apply a compaction proposal: insert merged memory, supersede the two originals.
// Idempotent: if proposal status != 'pending', no-op.
export async function applyCompactionProposal(proposalId: string, userId: string): Promise<{ ok: boolean; mergedId?: string; reason?: string }> {
  await ensureSchema();
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(`
      SELECT * FROM memory_compaction_proposals
      WHERE id=$1 AND "userId"=$2 FOR UPDATE
    `, [proposalId, userId]);
    if (!r.rows[0]) { await c.query("ROLLBACK"); return { ok: false, reason: "not found" }; }
    if (r.rows[0].status !== "pending") {
      await c.query("ROLLBACK");
      return { ok: false, reason: `already ${r.rows[0].status}` };
    }
    const proposal = r.rows[0];

    // Pull the source memories to copy scope (agentId, projectId)
    const src = await c.query(`SELECT "agentId", "projectId" FROM memories WHERE id=$1`, [proposal.memoryAId]);
    const scope = src.rows[0] || { agentId: null, projectId: null };

    // Generate embedding for merged content
    let embedding: number[] | null = null;
    try { embedding = await embedText(proposal.mergedContent, userId); } catch {}

    const mergedId = "mem_" + crypto.randomBytes(8).toString("hex");
    const now = Date.now();
    await c.query(`
      INSERT INTO memories (
        id, "userId", "agentId", "projectId", content, importance,
        state, category, embedding, "lastUsedAt", "createdAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, 'accepted', $7, $8, $9, $10)
    `, [
      mergedId, userId, scope.agentId, scope.projectId,
      proposal.mergedContent, proposal.mergedImportance || 5,
      proposal.mergedCategory,
      embedding ? JSON.stringify(embedding) : null,
      now, now,
    ]);

    // Mark sources superseded
    await c.query(`
      UPDATE memories SET state='superseded' WHERE id IN ($1, $2) AND "userId"=$3
    `, [proposal.memoryAId, proposal.memoryBId, userId]);

    await c.query(`
      UPDATE memory_compaction_proposals SET status='accepted', "resolvedAt"=$2 WHERE id=$1
    `, [proposalId, now]);

    await c.query("COMMIT");
    return { ok: true, mergedId };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export async function rejectCompactionProposal(proposalId: string, userId: string): Promise<{ ok: boolean }> {
  await ensureSchema();
  await pool().query(`
    UPDATE memory_compaction_proposals SET status='rejected', "resolvedAt"=$2
    WHERE id=$1 AND "userId"=$3
  `, [proposalId, Date.now(), userId]);
  return { ok: true };
}

export async function listCompactionProposals(userId: string, status: string = "pending", limit = 50): Promise<any[]> {
  await ensureSchema();
  const r = await pool().query(`
    SELECT p.*,
      ma.content as "memoryAContent",
      mb.content as "memoryBContent"
    FROM memory_compaction_proposals p
    LEFT JOIN memories ma ON p."memoryAId" = ma.id
    LEFT JOIN memories mb ON p."memoryBId" = mb.id
    WHERE p."userId"=$1 AND p.status=$2
    ORDER BY p.similarity DESC, p."createdAt" DESC
    LIMIT $3
  `, [userId, status, limit]);
  return r.rows;
}

// =================== DECAY SCORING ===================
//
// Recompute decay_score for all accepted memories of a user.
// decay_score = importance × 0.85^(days_since_used / 30)
// where days_since_used = (now - max(lastUsedAt, createdAt)) / day.
//
// Called from cron weekly, or on-demand from /learning. Cheap full-table scan.

export async function recomputeDecayScores(userId: string): Promise<{ updated: number }> {
  await ensureSchema();
  const r = await pool().query(`
    UPDATE memories
    SET "decayScore" = importance * power(0.85, GREATEST(0, EXTRACT(EPOCH FROM (now() - to_timestamp(GREATEST(COALESCE("lastUsedAt", "createdAt"), "createdAt") / 1000.0))) / 86400 / 30.0))
    WHERE "userId"=$1 AND state='accepted'
  `, [userId]);
  return { updated: r.rowCount || 0 };
}
