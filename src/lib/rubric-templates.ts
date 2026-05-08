// P26 — Built-in rubric templates.
//
// "Production Grade" is the user-flagged template that auto-attaches to all
// agents and enforces the engineering standard via deterministic + judge
// checks. Caveat language, incomplete plans, unhandled errors, and v0 vibes
// fail this rubric.
//
// Templates are seeded once by ensureBuiltinRubrics() (called from /api/rubrics
// GET if missing). Updates to template content bump the rubric's version
// field so existing evaluations keep their reproducible context.

import type { RubricCriterion } from "./rubrics-types";

export interface BuiltinRubricSpec {
  id: string;
  name: string;
  description: string;
  passingThreshold: number;     // overall weighted score must ≥ this to pass
  judgePassingScore: number;    // judge criteria must score ≥ this to count as passed (1-5 scale)
  criteria: RubricCriterion[];
}

export const PRODUCTION_GRADE_RUBRIC: BuiltinRubricSpec = {
  id: "rub_builtin_production_grade",
  name: "Production Grade",
  description:
    "Catches caveats, TODOs, incomplete plans, unhandled errors, and v0/proof-of-concept vibes. Auto-attached to every agent. Failed evaluations feed the correction-driven improvement loop.",
  passingThreshold: 0.7,
  judgePassingScore: 3.5,
  criteria: [
    {
      name: "no_caveat_language",
      description: "Output contains no caveat phrases like TODO, FIXME, v0, 'coming soon', 'for now', 'we'll add later', 'honest caveat', 'will fix later', 'placeholder', 'shippable later'.",
      weight: 0.25,
      type: "deterministic",
      required: true,
      check: {
        kind: "regex_absent",
        pattern: "\\bTODO\\b|\\bFIXME\\b|\\bv0\\b|coming soon|for now|we'?ll add later|honest caveat|will fix later|placeholder|shippable later|punt(?:ed| this| on)|hack(?:y| this)|temporary|hardcode(?:d)?",
        target: "output_text",
        flags: "i",
      },
    },
    {
      name: "plan_tasks_complete",
      description: "If the agent set a Plan Tasks list in working memory, all tasks must be checked off.",
      weight: 0.20,
      type: "deterministic",
      required: false,
      check: { kind: "plan_tasks_complete" },
    },
    {
      name: "no_unhandled_errors",
      description: "No unhandled error events in the run's trace. Tool errors that the agent caught and recovered from are fine.",
      weight: 0.15,
      type: "deterministic",
      required: true,
      check: {
        kind: "trace_event_absent",
        eventTypes: ["error"],
      },
    },
    {
      name: "all_tool_calls_succeeded",
      description: "Every tool call returned success.",
      weight: 0.10,
      type: "deterministic",
      required: false,
      check: { kind: "all_tool_calls_succeeded" },
    },
    {
      name: "budget_under_cap",
      description: "Run did not exhaust its budget cap (which would indicate incomplete work).",
      weight: 0.05,
      type: "deterministic",
      required: false,
      check: { kind: "budget_under_cap" },
    },
    {
      name: "completeness",
      description: "Does the response feel production-ready, or partial/v0/proof-of-concept?",
      weight: 0.15,
      type: "judge",
      required: false,
      scoringGuide: {
        5: "Genuinely production-ready. Every claim substantiated, every deferral explicitly tracked.",
        4: "Mostly complete with one or two minor gaps that don't undermine the work.",
        3: "Solid but has unaddressed deferrals or hand-waved sections.",
        2: "Partial work. Claims something is done but reads as in-progress.",
        1: "v0/proof-of-concept feel. Lots of placeholders or 'will add later' implicit.",
      },
    },
    {
      name: "deferrals_explicitly_tracked",
      description: "Are any deferred items called out with a specific tracking destination (later phase, follow-up commit, named TODO ticket)?",
      weight: 0.10,
      type: "judge",
      required: false,
      scoringGuide: {
        5: "Every deferred item explicitly named with where/when it'll land.",
        4: "Most deferrals tracked; one or two are vague.",
        3: "Some deferrals tracked; others hand-waved.",
        2: "Few deferrals tracked.",
        1: "Hand-waved entirely. 'Coming later' language without specifics.",
      },
    },
  ],
};

export const ALL_BUILTIN_RUBRICS: BuiltinRubricSpec[] = [
  PRODUCTION_GRADE_RUBRIC,
];
