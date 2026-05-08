// P26 fixture tests for deterministic rubric checks.

import { evaluateDeterministicCheck, type CheckInput } from "../rubric-deterministic";

function pass(label: string, cond: boolean) {
  if (!cond) { console.error("FAIL:", label); process.exit(1); }
  console.log("PASS:", label);
}

const baseInput: CheckInput = {
  outputText: "",
  systemBlocksText: "",
  toolCalls: [],
  traceEvents: [],
};

// =================== regex_absent (caveat detection) ===================
const caveatPattern = "\\bTODO\\b|\\bFIXME\\b|\\bv0\\b|coming soon|for now|we'?ll add later|honest caveat|placeholder";

const cleanOutput = evaluateDeterministicCheck(
  { kind: "regex_absent", pattern: caveatPattern, target: "output_text", flags: "i" },
  { ...baseInput, outputText: "Shipped a complete production-grade implementation." },
);
pass("clean output passes caveat check", cleanOutput.passed);

const dirtyTodo = evaluateDeterministicCheck(
  { kind: "regex_absent", pattern: caveatPattern, target: "output_text", flags: "i" },
  { ...baseInput, outputText: "Done with the table. TODO: hook up the chart later." },
);
pass("output with TODO fails caveat check", !dirtyTodo.passed);
pass("caveat finding includes match evidence", dirtyTodo.evidence?.match === "TODO");

const dirtyV0 = evaluateDeterministicCheck(
  { kind: "regex_absent", pattern: caveatPattern, target: "output_text", flags: "i" },
  { ...baseInput, outputText: "This is a v0 implementation, more soon." },
);
pass("output with v0 fails caveat check", !dirtyV0.passed);

// =================== plan_tasks_complete ===================
const planAllDone = evaluateDeterministicCheck(
  { kind: "plan_tasks_complete" },
  { ...baseInput, workingDocSections: [{ name: "Plan Tasks", content: "- [x] First\n- [x] Second" }] },
);
pass("all-done plan passes", planAllDone.passed);

const planSomeOpen = evaluateDeterministicCheck(
  { kind: "plan_tasks_complete" },
  { ...baseInput, workingDocSections: [{ name: "Plan Tasks", content: "- [x] First\n- [ ] Second\n- [ ] Third" }] },
);
pass("partially-done plan fails", !planSomeOpen.passed);

const noPlan = evaluateDeterministicCheck(
  { kind: "plan_tasks_complete" },
  { ...baseInput, workingDocSections: [{ name: "Plan Tasks", content: "" }] },
);
pass("no plan = pass (skip)", noPlan.passed);

// =================== budget_under_cap ===================
const underBudget = evaluateDeterministicCheck(
  { kind: "budget_under_cap" },
  { ...baseInput, run: { budgetCapCredits: 5000, spentCredits: 1500 } },
);
pass("under budget passes", underBudget.passed);

const overBudget = evaluateDeterministicCheck(
  { kind: "budget_under_cap" },
  { ...baseInput, run: { budgetCapCredits: 5000, spentCredits: 5000 } },
);
pass("at-cap fails", !overBudget.passed);

// =================== trace_event_absent ===================
const noErrors = evaluateDeterministicCheck(
  { kind: "trace_event_absent", eventTypes: ["error"] },
  { ...baseInput, traceEvents: [{ eventType: "tool_call", payload: {} }, { eventType: "tool_result", payload: { success: true } }] },
);
pass("no errors passes", noErrors.passed);

const hasError = evaluateDeterministicCheck(
  { kind: "trace_event_absent", eventTypes: ["error"] },
  { ...baseInput, traceEvents: [{ eventType: "error", payload: { source: "tool" } }] },
);
pass("has error fails", !hasError.passed);

// =================== all_tool_calls_succeeded ===================
const allOk = evaluateDeterministicCheck(
  { kind: "all_tool_calls_succeeded" },
  { ...baseInput, traceEvents: [
    { eventType: "tool_result", payload: { success: true } },
    { eventType: "tool_result", payload: { success: true } },
  ] },
);
pass("all tools succeeded passes", allOk.passed);

const someFailed = evaluateDeterministicCheck(
  { kind: "all_tool_calls_succeeded" },
  { ...baseInput, traceEvents: [
    { eventType: "tool_result", payload: { success: true, name: "a" } },
    { eventType: "tool_result", payload: { success: false, name: "b", resultPreview: "auth failed" } },
  ] },
);
pass("some tools failed fails", !someFailed.passed);

// =================== regex_present ===================
const requiredPresent = evaluateDeterministicCheck(
  { kind: "regex_present", pattern: "Source:", target: "output_text" },
  { ...baseInput, outputText: "Findings: x. Source: bls.gov." },
);
pass("required pattern present passes", requiredPresent.passed);

const requiredMissing = evaluateDeterministicCheck(
  { kind: "regex_present", pattern: "Source:", target: "output_text" },
  { ...baseInput, outputText: "Findings: x." },
);
pass("required pattern missing fails", !requiredMissing.passed);

console.log("");
console.log("All deterministic-check tests pass.");
