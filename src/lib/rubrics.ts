// P26 — Rubric storage + evaluation orchestration.
//
// Schema:
//   rubrics — definitions (built-in templates + user-created variants)
//   rubric_evaluations — append-only log of rubric runs against trace runs
//   improvement_proposals — recurring failure patterns surface as proposals
//
// Evaluation flow:
//   1. Fetch rubrics attached to (agentId | userId | global+builtin)
//   2. Pull run + events + tool calls + working doc
//   3. For each criterion:
//      - deterministic: evaluateDeterministicCheck → 0/1 score
//      - judge: judgeCriterion → 1-5 score
//   4. Aggregate to weighted-mean overall score; required criteria failing
//      override to overall=fail regardless of score
//   5. Insert rubric_evaluations row
//   6. If failed: feed into improvement-proposal pattern detector

import crypto from "node:crypto";
import { pool } from "./db";
import { evaluateDeterministicCheck, type CheckInput } from "./rubric-deterministic";
import { judgeCriterion, summarizeTools, JUDGE_PROMPT_VERSION } from "./rubric-judge";
import { ALL_BUILTIN_RUBRICS, type BuiltinRubricSpec } from "./rubric-templates";
import type { RubricCriterion, CriterionFinding } from "./rubrics-types";
import { audit } from "./audit";

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS rubrics (
      id TEXT PRIMARY KEY,
      "userId" TEXT,
      name TEXT NOT NULL,
      description TEXT,
      scope TEXT NOT NULL DEFAULT 'global',
      "scopeId" TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      "isBuiltin" BOOLEAN DEFAULT FALSE,
      "isPinned" BOOLEAN DEFAULT FALSE,
      criteria JSONB NOT NULL,
      "passingThreshold" REAL DEFAULT 0.7,
      "judgePassingScore" REAL DEFAULT 3.5,
      "judgeModel" TEXT,
      "judgePromptVersion" INTEGER DEFAULT 1,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rubric_evaluations (
      id BIGSERIAL PRIMARY KEY,
      "rubricId" TEXT NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
      "rubricVersion" INTEGER NOT NULL,
      "runId" TEXT,
      "userId" TEXT NOT NULL,
      "agentId" TEXT,
      "overallScore" REAL,
      "passed" BOOLEAN,
      findings JSONB NOT NULL,
      "judgeModel" TEXT,
      "judgePromptVersion" INTEGER,
      "evaluatedAt" BIGINT NOT NULL,
      metadata JSONB
    );

    CREATE TABLE IF NOT EXISTS improvement_proposals (
      id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "agentId" TEXT,
      "rubricId" TEXT REFERENCES rubrics(id) ON DELETE SET NULL,
      "criterionName" TEXT NOT NULL,
      "patternKey" TEXT NOT NULL,
      "occurrenceCount" INTEGER DEFAULT 1,
      "proposedChange" JSONB NOT NULL,
      status TEXT DEFAULT 'pending',
      evidence JSONB,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL,
      "resolvedAt" BIGINT,
      UNIQUE("userId", "agentId", "criterionName", "patternKey")
    );

    CREATE INDEX IF NOT EXISTS idx_rubric_eval_run ON rubric_evaluations("runId", "evaluatedAt" DESC);
    CREATE INDEX IF NOT EXISTS idx_rubric_eval_user ON rubric_evaluations("userId", "evaluatedAt" DESC);
    CREATE INDEX IF NOT EXISTS idx_rubric_eval_agent_passed ON rubric_evaluations("agentId", "passed", "evaluatedAt" DESC);
    CREATE INDEX IF NOT EXISTS idx_rubric_user ON rubrics("userId", "isPinned");
    CREATE INDEX IF NOT EXISTS idx_improvement_user ON improvement_proposals("userId", status, "createdAt" DESC);
  `);
  _initialized = true;
  await ensureBuiltinRubrics();
}

async function ensureBuiltinRubrics() {
  for (const tmpl of ALL_BUILTIN_RUBRICS) {
    await pool().query(`
      INSERT INTO rubrics (id, name, description, scope, "isBuiltin", "isPinned", criteria, "passingThreshold", "judgePassingScore", "judgePromptVersion", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, 'global', TRUE, TRUE, $4, $5, $6, $7, $8, $8)
      ON CONFLICT (id) DO UPDATE
        SET criteria = EXCLUDED.criteria,
            description = EXCLUDED.description,
            "passingThreshold" = EXCLUDED."passingThreshold",
            "judgePassingScore" = EXCLUDED."judgePassingScore",
            "judgePromptVersion" = EXCLUDED."judgePromptVersion",
            "updatedAt" = EXCLUDED."updatedAt",
            version = rubrics.version + 1
    `, [tmpl.id, tmpl.name, tmpl.description, JSON.stringify(tmpl.criteria),
        tmpl.passingThreshold, tmpl.judgePassingScore, JUDGE_PROMPT_VERSION, Date.now()]);
  }
}

// =================== CRUD ===================

export interface RubricRow {
  id: string;
  userId: string | null;
  name: string;
  description: string | null;
  scope: string;
  scopeId: string | null;
  version: number;
  isBuiltin: boolean;
  isPinned: boolean;
  criteria: RubricCriterion[];
  passingThreshold: number;
  judgePassingScore: number;
  judgeModel: string | null;
  judgePromptVersion: number;
  createdAt: number;
  updatedAt: number;
}

export async function listRubrics(userId: string): Promise<RubricRow[]> {
  await ensureSchema();
  const r = await pool().query(`
    SELECT * FROM rubrics
    WHERE "userId" = $1 OR "isBuiltin" = TRUE
    ORDER BY "isPinned" DESC, "isBuiltin" DESC, name ASC
  `, [userId]);
  return r.rows.map(parseRubricRow);
}

// P44 — rubrics applicable to a specific agent. Includes:
//   - global / built-in rubrics (always)
//   - user-scoped rubrics (scope='user' AND userId match) — same as today
//   - agent-scoped rubrics (scope='agent' AND scopeId = agentId)
//
// listRubrics for the agent builder UI; listApplicableRubrics for runtime
// evaluation. The runtime path filters by isPinned for auto-eval; the
// builder UI shows everything so users can pin/unpin per-agent.
export async function listApplicableRubrics(userId: string, agentId: string | null): Promise<RubricRow[]> {
  await ensureSchema();
  const r = await pool().query(`
    SELECT * FROM rubrics
    WHERE ("isBuiltin" = TRUE)
       OR ("userId" = $1 AND scope = 'user')
       OR ("userId" = $1 AND scope = 'global')
       OR ($2::text IS NOT NULL AND "userId" = $1 AND scope = 'agent' AND "scopeId" = $2::text)
    ORDER BY "isPinned" DESC, "isBuiltin" DESC, name ASC
  `, [userId, agentId]);
  return r.rows.map(parseRubricRow);
}

export async function getRubric(id: string, userId: string): Promise<RubricRow | null> {
  await ensureSchema();
  const r = await pool().query(`
    SELECT * FROM rubrics WHERE id=$1 AND ("userId"=$2 OR "isBuiltin" = TRUE)
  `, [id, userId]);
  return r.rows[0] ? parseRubricRow(r.rows[0]) : null;
}

export async function createRubric(input: {
  userId: string;
  name: string;
  description?: string;
  scope?: string;
  scopeId?: string;
  criteria: RubricCriterion[];
  passingThreshold?: number;
  judgePassingScore?: number;
}): Promise<RubricRow> {
  await ensureSchema();
  const id = "rub_" + crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  await pool().query(`
    INSERT INTO rubrics (id, "userId", name, description, scope, "scopeId", criteria, "passingThreshold", "judgePassingScore", "judgePromptVersion", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
  `, [id, input.userId, input.name, input.description || null,
      input.scope || "user", input.scopeId || null,
      JSON.stringify(input.criteria),
      input.passingThreshold ?? 0.7,
      input.judgePassingScore ?? 3.5,
      JUDGE_PROMPT_VERSION, now]);
  await audit({ userId: input.userId, action: "agent.create", resource: `rubric:${id}`, result: "success", metadata: { criteriaCount: input.criteria.length } });
  return (await getRubric(id, input.userId))!;
}

function parseRubricRow(row: any): RubricRow {
  return {
    ...row,
    criteria: typeof row.criteria === "string" ? JSON.parse(row.criteria) : row.criteria,
    isBuiltin: !!row.isBuiltin,
    isPinned: !!row.isPinned,
    passingThreshold: Number(row.passingThreshold || 0.7),
    judgePassingScore: Number(row.judgePassingScore || 3.5),
  };
}

// =================== EVALUATION ===================

export interface EvalInput {
  rubric: RubricRow;
  userId: string;
  agentId: string | null;
  runId: string | null;
  userMessage: string;
  agentResponse: string;
  systemBlocksText: string;
  toolCalls: Array<{ name: string; args: any; result?: string; success?: boolean }>;
  traceEvents: Array<{ eventType: string; payload: any }>;
  workingDocSections?: Array<{ name: string; content: string }>;
  run?: { budgetCapCredits?: number | null; spentCredits?: number | null };
  artifactIds?: string[];
}

export interface EvalResult {
  rubricId: string;
  rubricVersion: number;
  overallScore: number;     // 0..1 weighted
  passed: boolean;
  findings: CriterionFinding[];
  failedRequired: boolean;
  judgeModel?: string;
  judgePromptVersion?: number;
}

export async function evaluateRubric(input: EvalInput): Promise<EvalResult> {
  await ensureSchema();
  const findings: CriterionFinding[] = [];
  const checkInput: CheckInput = {
    outputText: input.agentResponse,
    systemBlocksText: input.systemBlocksText,
    toolCalls: input.toolCalls,
    traceEvents: input.traceEvents,
    workingDocSections: input.workingDocSections,
    run: input.run,
    artifactIds: input.artifactIds,
  };

  let totalWeight = 0;
  let weightedScore = 0;
  let failedRequired = false;
  let usedJudge = false;

  for (const criterion of input.rubric.criteria) {
    if (criterion.type === "deterministic") {
      if (!criterion.check) {
        findings.push({
          name: criterion.name, type: criterion.type, weight: criterion.weight,
          required: criterion.required, passed: false, score: 0,
          details: "deterministic criterion missing check spec",
        });
        if (criterion.required) failedRequired = true;
        continue;
      }
      const r = evaluateDeterministicCheck(criterion.check, checkInput);
      const score = r.passed ? 1 : 0;
      findings.push({
        name: criterion.name, type: "deterministic", weight: criterion.weight,
        required: criterion.required, passed: r.passed, score,
        details: r.details, evidence: r.evidence,
      });
      totalWeight += criterion.weight;
      weightedScore += score * criterion.weight;
      if (!r.passed && criterion.required) failedRequired = true;
    } else {
      // Judge call
      try {
        const j = await judgeCriterion({
          criterion: { name: criterion.name, description: criterion.description, scoringGuide: criterion.scoringGuide },
          userMessage: input.userMessage,
          agentResponse: input.agentResponse,
          toolSummary: summarizeTools(input.toolCalls),
          userId: input.userId,
        });
        usedJudge = true;
        const normalizedScore = j.score / 5;
        const passed = j.score >= input.rubric.judgePassingScore;
        findings.push({
          name: criterion.name, type: "judge", weight: criterion.weight,
          required: criterion.required, passed, score: normalizedScore,
          details: j.reasoning, evidence: j.evidence,
        });
        totalWeight += criterion.weight;
        weightedScore += normalizedScore * criterion.weight;
        if (!passed && criterion.required) failedRequired = true;
      } catch (err: any) {
        findings.push({
          name: criterion.name, type: "judge", weight: criterion.weight,
          required: criterion.required, passed: false, score: 0,
          details: `judge error: ${err?.message}`,
        });
        if (criterion.required) failedRequired = true;
      }
    }
  }

  const overallScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const passed = !failedRequired && overallScore >= input.rubric.passingThreshold;

  // Persist evaluation
  await pool().query(`
    INSERT INTO rubric_evaluations
      ("rubricId", "rubricVersion", "runId", "userId", "agentId", "overallScore", "passed", findings, "judgeModel", "judgePromptVersion", "evaluatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
    input.rubric.id, input.rubric.version, input.runId, input.userId, input.agentId || null,
    overallScore, passed, JSON.stringify(findings),
    usedJudge ? input.rubric.judgeModel || null : null,
    usedJudge ? JUDGE_PROMPT_VERSION : null,
    Date.now(),
  ]);

  return {
    rubricId: input.rubric.id,
    rubricVersion: input.rubric.version,
    overallScore, passed, findings, failedRequired,
    judgeModel: usedJudge ? input.rubric.judgeModel || undefined : undefined,
    judgePromptVersion: usedJudge ? JUDGE_PROMPT_VERSION : undefined,
  };
}

// Eval all rubrics that apply to (userId, agentId). User-scoped + builtins
// are picked up; non-pinned rubrics are skipped to avoid surprise evals.
export async function evaluateAllApplicable(
  baseInput: Omit<EvalInput, "rubric">,
): Promise<EvalResult[]> {
  await ensureSchema();
  // P44 — narrow to rubrics scoped to this agent (or global) instead of
  // every rubric the user has access to. Per-agent binding lets users
  // attach a rubric to a single agent without polluting other agents.
  const all = await listApplicableRubrics(baseInput.userId, baseInput.agentId);
  const applicable = all.filter(r => r.isPinned);  // only pinned rubrics auto-eval
  const results: EvalResult[] = [];
  for (const rubric of applicable) {
    try {
      results.push(await evaluateRubric({ ...baseInput, rubric }));
    } catch (e) {
      console.error(`[evaluateAllApplicable] rubric ${rubric.id} failed:`, e);
    }
  }
  return results;
}

// P44 — Bind / unbind a rubric to an agent. Mutates rubric.scope +
// scopeId in place. Auth: rubric must belong to the user (built-in or
// user-scoped). Built-in rubrics can be agent-bound by *cloning* —
// agents typically need to scope a built-in like "Production-Grade" to
// just one focused agent.
export async function bindRubricToAgent(
  rubricId: string, userId: string, agentId: string | null,
): Promise<{ ok: boolean; rubric?: RubricRow }> {
  await ensureSchema();
  const r = await pool().query(
    `SELECT * FROM rubrics WHERE id=$1 AND ("userId"=$2 OR "isBuiltin"=TRUE)`,
    [rubricId, userId],
  );
  if (!r.rows[0]) return { ok: false };
  // For built-in rubrics, clone instead of mutating — multiple users
  // share built-ins so we mustn't tie one user's binding to a global row.
  if (r.rows[0].isBuiltin) {
    if (agentId === null) return { ok: false };
    const cloneId = "rb_" + (await import("node:crypto")).randomBytes(8).toString("hex");
    const orig = r.rows[0];
    await pool().query(
      `INSERT INTO rubrics (id, "userId", name, description, scope, "scopeId", version, "isBuiltin", "isPinned", criteria, "passingThreshold", "judgePassingScore", "judgeModel", "judgePromptVersion", "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,'agent',$5,1,FALSE,FALSE,$6,$7,$8,$9,$10,$11,$11)`,
      [cloneId, userId, `${orig.name} (cloned)`, orig.description, agentId, orig.criteria,
       orig.passingThreshold, orig.judgePassingScore, orig.judgeModel, orig.judgePromptVersion, Date.now()],
    );
    const cloned = await pool().query(`SELECT * FROM rubrics WHERE id=$1`, [cloneId]);
    return { ok: true, rubric: parseRubricRow(cloned.rows[0]) };
  }
  // User-scoped: mutate scope + scopeId.
  const next = agentId
    ? { scope: "agent", scopeId: agentId }
    : { scope: "user", scopeId: null };
  await pool().query(
    `UPDATE rubrics SET scope=$1, "scopeId"=$2, "updatedAt"=$3 WHERE id=$4`,
    [next.scope, next.scopeId, Date.now(), rubricId],
  );
  const updated = await pool().query(`SELECT * FROM rubrics WHERE id=$1`, [rubricId]);
  return { ok: true, rubric: parseRubricRow(updated.rows[0]) };
}

export async function listEvaluationsForRun(runId: string, userId: string): Promise<any[]> {
  await ensureSchema();
  const r = await pool().query(`
    SELECT * FROM rubric_evaluations
    WHERE "runId"=$1 AND "userId"=$2
    ORDER BY "evaluatedAt" DESC
  `, [runId, userId]);
  return r.rows;
}

export async function listRecentEvaluations(userId: string, limit = 50): Promise<any[]> {
  await ensureSchema();
  const r = await pool().query(`
    SELECT * FROM rubric_evaluations
    WHERE "userId"=$1
    ORDER BY "evaluatedAt" DESC LIMIT $2
  `, [userId, limit]);
  return r.rows;
}
