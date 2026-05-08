// P26 — Rubric type definitions extracted into a small module so deterministic
// checks, judge prompts, and templates can share without circular imports.

import type { DeterministicCheck } from "./rubric-deterministic";

export type CriterionType = "deterministic" | "judge";

export interface RubricCriterion {
  name: string;
  description: string;
  weight: number;            // 0..1; criteria don't have to sum to 1 — we normalize at eval time
  type: CriterionType;
  required: boolean;         // if true, this criterion failing fails the entire rubric
  // For deterministic checks
  check?: DeterministicCheck;
  // For judge checks
  scoringGuide?: Record<number, string>;
}

export interface CriterionFinding {
  name: string;
  type: CriterionType;
  weight: number;
  required: boolean;
  passed: boolean;
  score: number;             // 0..1 for deterministic (1 if passed, 0 if not), 1-5/5 for judge
  details: string;
  evidence?: any;
}
