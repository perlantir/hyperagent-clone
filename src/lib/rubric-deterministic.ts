// P26 — Deterministic rubric checks.
//
// These run BEFORE the LLM-as-judge layer. They catch the obvious stuff that
// doesn't require a judgment call: caveat language, TODOs, incomplete tasks,
// budget overrun, error events in trace.
//
// Pure functions where possible. The trace-aware checks take a list of
// trace_events; the run-aware checks take the trace_run row.

import { parsePlanTasks } from "./working-memory-parse";

export type DeterministicCheckKind =
  | "regex_absent"        // pattern must NOT appear in target text
  | "regex_present"       // pattern MUST appear
  | "json_valid"          // target must parse as JSON
  | "trace_event_absent"  // trace must NOT contain events of given type(s)
  | "trace_event_present" // trace MUST contain events of given type(s)
  | "plan_tasks_complete" // working doc Plan Tasks all checked
  | "budget_under_cap"    // run.spentCredits < run.budgetCapCredits
  | "artifacts_present"   // ≥1 artifact created
  | "no_loop_detected"    // no loop_detector errors in trace
  | "all_tool_calls_succeeded"; // every tool_result has success=true

export interface DeterministicCheck {
  kind: DeterministicCheckKind;
  pattern?: string;          // regex literal for regex_* checks
  target?: "output_text" | "system_prompt" | "tool_results";
  eventTypes?: string[];      // for trace_event_* checks
  flags?: string;             // regex flags
}

export interface CheckInput {
  outputText: string;
  systemBlocksText: string;
  toolCalls: Array<{ name: string; args: any; result?: string; success?: boolean }>;
  traceEvents: Array<{ eventType: string; payload: any }>;
  workingDocSections?: Array<{ name: string; content: string }>;
  run?: { budgetCapCredits?: number | null; spentCredits?: number | null };
  artifactIds?: string[];
}

export interface CheckResult {
  passed: boolean;
  details: string;
  evidence?: any;
}

export function evaluateDeterministicCheck(check: DeterministicCheck, input: CheckInput): CheckResult {
  switch (check.kind) {
    case "regex_absent": return regexAbsent(check, input);
    case "regex_present": return regexPresent(check, input);
    case "json_valid": return jsonValid(check, input);
    case "trace_event_absent": return traceEventAbsent(check, input);
    case "trace_event_present": return traceEventPresent(check, input);
    case "plan_tasks_complete": return planTasksComplete(input);
    case "budget_under_cap": return budgetUnderCap(input);
    case "artifacts_present": return artifactsPresent(input);
    case "no_loop_detected": return noLoopDetected(input);
    case "all_tool_calls_succeeded": return allToolCallsSucceeded(input);
    default:
      return { passed: false, details: `unknown check kind: ${(check as any).kind}` };
  }
}

function getTargetText(target: DeterministicCheck["target"], input: CheckInput): string {
  switch (target) {
    case "system_prompt": return input.systemBlocksText;
    case "tool_results": return input.toolCalls.map(t => t.result || "").join("\n");
    case "output_text":
    default: return input.outputText;
  }
}

function regexAbsent(check: DeterministicCheck, input: CheckInput): CheckResult {
  if (!check.pattern) return { passed: false, details: "no pattern provided" };
  const text = getTargetText(check.target, input);
  const re = new RegExp(check.pattern, check.flags ?? "i");
  const match = re.exec(text);
  if (match) {
    return {
      passed: false,
      details: `Forbidden pattern matched: "${match[0]}"`,
      evidence: { match: match[0], context: contextSnippet(text, match.index || 0) },
    };
  }
  return { passed: true, details: `Pattern absent (good)` };
}

function regexPresent(check: DeterministicCheck, input: CheckInput): CheckResult {
  if (!check.pattern) return { passed: false, details: "no pattern provided" };
  const text = getTargetText(check.target, input);
  const re = new RegExp(check.pattern, check.flags ?? "i");
  if (re.test(text)) return { passed: true, details: `Pattern present (good)` };
  return { passed: false, details: `Required pattern not found: ${check.pattern}` };
}

function jsonValid(check: DeterministicCheck, input: CheckInput): CheckResult {
  const text = getTargetText(check.target, input);
  try { JSON.parse(text.trim()); return { passed: true, details: "Valid JSON" }; }
  catch (e: any) { return { passed: false, details: `Invalid JSON: ${e.message}` }; }
}

function traceEventAbsent(check: DeterministicCheck, input: CheckInput): CheckResult {
  const types = new Set(check.eventTypes || []);
  const matches = input.traceEvents.filter(e => types.has(e.eventType));
  if (matches.length === 0) {
    return { passed: true, details: `No ${[...types].join("/")} events (good)` };
  }
  return {
    passed: false,
    details: `Found ${matches.length} forbidden event(s): ${[...types].join(", ")}`,
    evidence: matches.slice(0, 3).map(m => ({ eventType: m.eventType, payload: m.payload })),
  };
}

function traceEventPresent(check: DeterministicCheck, input: CheckInput): CheckResult {
  const types = new Set(check.eventTypes || []);
  const matches = input.traceEvents.filter(e => types.has(e.eventType));
  if (matches.length > 0) {
    return { passed: true, details: `Found ${matches.length} required event(s)` };
  }
  return { passed: false, details: `Required event type(s) missing: ${[...types].join(", ")}` };
}

function planTasksComplete(input: CheckInput): CheckResult {
  const planSection = input.workingDocSections?.find(s => s.name.toLowerCase() === "plan tasks");
  if (!planSection || !planSection.content.trim()) {
    return { passed: true, details: "No plan was set (skip)" };
  }
  const tasks = parsePlanTasks(planSection.content);
  if (tasks.length === 0) {
    return { passed: true, details: "No checkbox tasks in plan (skip)" };
  }
  const incomplete = tasks.filter(t => !t.done);
  if (incomplete.length > 0) {
    return {
      passed: false,
      details: `${incomplete.length} of ${tasks.length} plan tasks incomplete`,
      evidence: { incomplete: incomplete.slice(0, 5).map(t => t.text) },
    };
  }
  return { passed: true, details: `All ${tasks.length} plan tasks completed` };
}

function budgetUnderCap(input: CheckInput): CheckResult {
  const cap = Number(input.run?.budgetCapCredits || 0);
  const spent = Number(input.run?.spentCredits || 0);
  if (!cap) return { passed: true, details: "No budget cap set (skip)" };
  if (spent >= cap) {
    return {
      passed: false,
      details: `Hit budget cap (${spent}/${cap} credits)`,
      evidence: { spent, cap },
    };
  }
  const headroom = cap - spent;
  return { passed: true, details: `Spent ${spent}/${cap} (${headroom} remaining)` };
}

function artifactsPresent(input: CheckInput): CheckResult {
  const count = input.artifactIds?.length || 0;
  if (count > 0) return { passed: true, details: `${count} artifact(s) created` };
  return { passed: false, details: "No artifacts created" };
}

function noLoopDetected(input: CheckInput): CheckResult {
  const loopErrors = input.traceEvents.filter(e =>
    e.eventType === "error" && e.payload?.source === "loop_detector"
  );
  if (loopErrors.length > 0) {
    return {
      passed: false,
      details: `Loop detected (${loopErrors[0].payload?.reason || "unknown"})`,
      evidence: loopErrors[0].payload,
    };
  }
  return { passed: true, details: "No loops" };
}

function allToolCallsSucceeded(input: CheckInput): CheckResult {
  const toolResults = input.traceEvents.filter(e => e.eventType === "tool_result");
  if (toolResults.length === 0) return { passed: true, details: "No tool calls (skip)" };
  const failed = toolResults.filter(e => e.payload?.success === false);
  if (failed.length === 0) {
    return { passed: true, details: `All ${toolResults.length} tool calls succeeded` };
  }
  return {
    passed: false,
    details: `${failed.length} of ${toolResults.length} tool calls failed`,
    evidence: failed.slice(0, 3).map(f => ({ name: f.payload?.name, error: f.payload?.resultPreview })),
  };
}

function contextSnippet(text: string, index: number, radius = 40): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
