// P26 — Correction-driven improvement proposals (Deskimo pattern).
//
// When a rubric criterion fails, we record (userId, agentId, criterionName,
// patternKey) where patternKey is a stable hash of the failure shape. If the
// same pattern occurs in 3+ evaluations within 30 days, we generate a draft
// proposal: "your agent keeps doing X — consider adding Y to its system
// prompt."
//
// Proposals don't auto-apply. They land in improvement_proposals with
// status='pending' and surface in /learning (P25b/P32) for the user to
// accept/reject. Accepted proposals are applied as agent system-prompt
// additions or new rubric criteria.

import crypto from "node:crypto";
import { pool } from "./db";
import type { CriterionFinding } from "./rubrics-types";

const RECURRENCE_THRESHOLD = 3;          // 3rd occurrence triggers a proposal
const RECURRENCE_WINDOW_MS = 30 * 24 * 3600 * 1000;

export type ProposedChangeType =
  | "system_prompt_addition"
  | "new_rubric_criterion"
  | "skill_suggestion";

export interface ProposedChange {
  type: ProposedChangeType;
  rationale: string;
  content: string;            // for system_prompt_addition: the text to append
  diff?: string;              // optional pretty-printed diff
}

export async function recordFinding(input: {
  userId: string;
  agentId: string | null;
  rubricId: string;
  finding: CriterionFinding;
}): Promise<{ created: boolean; proposalId?: string }> {
  if (input.finding.passed) return { created: false };

  const patternKey = hashFailurePattern(input.finding);
  const existing = await pool().query(`
    SELECT id, "occurrenceCount", evidence FROM improvement_proposals
    WHERE "userId"=$1 AND "agentId" IS NOT DISTINCT FROM $2
      AND "criterionName"=$3 AND "patternKey"=$4
      AND status IN ('pending', 'accepted')
    LIMIT 1
  `, [input.userId, input.agentId || null, input.finding.name, patternKey]);

  const now = Date.now();
  if (existing.rows[0]) {
    // Bump occurrence + append evidence (cap at 10)
    const row = existing.rows[0];
    const evidence = Array.isArray(row.evidence) ? row.evidence : [];
    evidence.push({ at: now, details: input.finding.details, evidence: input.finding.evidence });
    if (evidence.length > 10) evidence.shift();
    await pool().query(`
      UPDATE improvement_proposals
      SET "occurrenceCount" = "occurrenceCount" + 1,
          evidence = $2,
          "updatedAt" = $3
      WHERE id = $1
    `, [row.id, JSON.stringify(evidence), now]);
    return { created: false, proposalId: row.id };
  }

  // First occurrence — record it but don't generate a proposal yet
  const proposalId = "imp_" + crypto.randomBytes(8).toString("hex");
  const proposedChange = generateProposalDraft(input.finding);
  await pool().query(`
    INSERT INTO improvement_proposals
      (id, "userId", "agentId", "rubricId", "criterionName", "patternKey",
       "occurrenceCount", "proposedChange", evidence, "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $9)
  `, [
    proposalId, input.userId, input.agentId || null, input.rubricId,
    input.finding.name, patternKey,
    JSON.stringify(proposedChange),
    JSON.stringify([{ at: now, details: input.finding.details, evidence: input.finding.evidence }]),
    now,
  ]);
  return { created: true, proposalId };
}

// Stable hash of the "shape" of a failure so different occurrences of the
// same root cause cluster together. We use the criterion name + evidence
// regex match (or first phrase of details) as the bucket key.
function hashFailurePattern(finding: CriterionFinding): string {
  let token = finding.details.slice(0, 60);
  if (finding.evidence) {
    if (finding.evidence.match) token = finding.evidence.match;
    else if (typeof finding.evidence === "string") token = finding.evidence.slice(0, 60);
  }
  return crypto.createHash("sha256")
    .update(`${finding.name}|${token.toLowerCase().trim()}`)
    .digest("hex").slice(0, 12);
}

function generateProposalDraft(finding: CriterionFinding): ProposedChange {
  // Default: propose a system-prompt addition that explicitly forbids the failed pattern.
  // Specific criteria get tailored proposals.
  switch (finding.name) {
    case "no_caveat_language":
      return {
        type: "system_prompt_addition",
        rationale: `The ${finding.name} criterion failed (caveat language found in output: ${(finding.evidence as any)?.match || "unknown"}). The agent keeps shipping work with TODO/v0/coming-soon language.`,
        content: "PRODUCTION-GRADE OUTPUT: Never use caveat language (TODO, FIXME, v0, 'coming soon', 'for now', 'we'll add later', 'placeholder'). If something is intentionally deferred, explicitly track it: '[Deferred to phase X]' or '[Tracked as follow-up: Y]'. If something is incomplete, finish it before responding.",
      };
    case "plan_tasks_complete":
      return {
        type: "system_prompt_addition",
        rationale: "The agent keeps leaving Plan Tasks unchecked at the end of runs.",
        content: "Before declaring work done, verify every task in the working doc Plan Tasks section is checked off via update_working_memory. If a task is intentionally being skipped, mark it [SKIPPED: reason] rather than leaving it open.",
      };
    case "no_unhandled_errors":
      return {
        type: "system_prompt_addition",
        rationale: "The agent's runs keep producing unhandled errors in the trace.",
        content: "When a tool call fails, either retry once with adjusted args, find an alternative path, or surface the error to the user with a clear explanation. Never silently proceed past an error event.",
      };
    case "deferrals_explicitly_tracked":
      return {
        type: "system_prompt_addition",
        rationale: "Judge keeps scoring the agent low on deferral tracking.",
        content: "Every deferral must specify WHERE it'll be addressed (which phase, which follow-up, which ticket). 'We'll get to it' is not acceptable; 'Tracked to P28b for replay UI' is.",
      };
    case "completeness":
      return {
        type: "system_prompt_addition",
        rationale: "Judge keeps scoring the agent's outputs as partial/v0.",
        content: "Match the depth of your response to the request's complexity. Don't ship hand-wavy summaries when full structured output is appropriate. If you're not sure something is production-grade, ask before declaring done.",
      };
    default:
      return {
        type: "system_prompt_addition",
        rationale: `Recurring failure on ${finding.name}: ${finding.details}`,
        content: `Avoid the pattern that caused: ${finding.details}`,
      };
  }
}

export async function listPendingProposals(userId: string, limit = 50): Promise<any[]> {
  const r = await pool().query(`
    SELECT * FROM improvement_proposals
    WHERE "userId"=$1 AND status='pending' AND "occurrenceCount" >= $2
    ORDER BY "occurrenceCount" DESC, "updatedAt" DESC
    LIMIT $3
  `, [userId, RECURRENCE_THRESHOLD, limit]);
  return r.rows;
}

export async function listAllProposals(userId: string, status?: string, limit = 50): Promise<any[]> {
  const params: any[] = [userId, limit];
  let stateClause = "";
  if (status) { params.splice(1, 0, status); stateClause = ` AND status=$2`; }
  const r = await pool().query(`
    SELECT * FROM improvement_proposals
    WHERE "userId"=$1${stateClause}
    ORDER BY "updatedAt" DESC LIMIT ${status ? "$3" : "$2"}
  `, params);
  return r.rows;
}

export async function resolveProposal(
  proposalId: string,
  userId: string,
  status: "accepted" | "rejected" | "superseded",
): Promise<{ ok: boolean }> {
  await pool().query(`
    UPDATE improvement_proposals
    SET status=$3, "resolvedAt"=$4, "updatedAt"=$4
    WHERE id=$1 AND "userId"=$2
  `, [proposalId, userId, status, Date.now()]);
  return { ok: true };
}
