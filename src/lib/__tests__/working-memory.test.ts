// P24 fixture tests for working-memory parsing.

import { parsePlanTasks, planProgress } from "../working-memory-parse";

function pass(label: string, cond: boolean) {
  if (!cond) { console.error("FAIL:", label); process.exit(1); }
  console.log("PASS:", label);
}

// 1. Empty content → no tasks
pass("empty parses to []", parsePlanTasks("").length === 0);

// 2. Mixed checked/unchecked
const mixed = parsePlanTasks([
  "- [ ] Research competitors",
  "- [x] Build comparison table",
  "- [ ] Generate webpage",
].join("\n"));
pass("mixed list has 3 tasks", mixed.length === 3);
pass("first task is open", !mixed[0].done);
pass("second task is done", mixed[1].done);
pass("third task is open", !mixed[2].done);
pass("task text trimmed", mixed[0].text === "Research competitors");

// 3. Indentation tolerated
const indented = parsePlanTasks([
  "  - [ ] indented task",
  "    - [x] deeply indented",
].join("\n"));
pass("indented tasks parsed", indented.length === 2);

// 4. Non-task lines ignored
const withProse = parsePlanTasks([
  "Here's the plan:",
  "- [ ] Do thing A",
  "Some commentary.",
  "- [x] Do thing B",
  "",
].join("\n"));
pass("prose lines skipped", withProse.length === 2);
pass("checkbox state preserved across prose", !withProse[0].done && withProse[1].done);

// 5. Progress calculation
const progress = planProgress(mixed);
pass("progress reports 1 of 3", progress?.done === 1 && progress?.total === 3);
pass("progress ratio ≈ 0.333", Math.abs((progress?.ratio || 0) - 1/3) < 0.01);

// 6. Empty progress is null
pass("empty tasks → null progress", planProgress([]) === null);

// 7. Capital X works
const capX = parsePlanTasks("- [X] Done with capital X");
pass("capital X recognized as done", capX.length === 1 && capX[0].done);

console.log("");
console.log("All working-memory tests pass.");
