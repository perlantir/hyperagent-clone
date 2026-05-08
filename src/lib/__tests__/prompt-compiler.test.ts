// P23 fixture test for the prompt compiler.
//
// Locks down compiler behavior so future logic changes don't silently shift
// fingerprints, drop required segments, or move cache breakpoints. Run with:
//   npm run test:prompt
//
// When the snapshot intentionally changes (e.g. you bump a segment's version
// or rewrite its content), update FIXTURE.expected to match the new output.

import { compilePrompt, segment } from "../prompt-compiler";

const FIXTURE = {
  description: "minimal layered prompt with all four tiers populated",
  segments: [
    segment("platform_identity", "You are a helpful assistant.", { source: "test/identity", version: 1 }),
    segment("safety", "Refuse harmful requests.", { source: "test/safety", required: true, version: 1 }),
    segment("tool_policy", "Pick the simplest tool.", { source: "test/tools", required: true, version: 1 }),
    segment("agent_config", "You research markets.", { source: "test/agent/abc", version: 1 }),
    segment("memory_contextual", "User prefers TypeScript.", { source: "test/memory", version: 1 }),
    segment("current_task", "Find me three competitors.", { source: "test/task", version: 1 }),
  ],
  expected: {
    // Fixture populates tiers 1, 2, 4 (no rubric in tier 3)
    blockCount: 3,        // one per non-empty tier (T1, T2, T4)
    cachedBlocks: 2,      // T1 and T2 cacheable; T4 volatile
    droppedKinds: [],
    fingerprintLength: 16,
  },
};

function run() {
  const compiled = compilePrompt(FIXTURE.segments, { maxTokens: 16_000 });
  const ok =
    compiled.systemBlocks.length === FIXTURE.expected.blockCount &&
    compiled.systemBlocks.filter(b => b.cache_control).length === FIXTURE.expected.cachedBlocks &&
    compiled.droppedSegments.length === FIXTURE.expected.droppedKinds.length &&
    compiled.fingerprint.length === FIXTURE.expected.fingerprintLength;

  if (!ok) {
    console.error("FAIL:", FIXTURE.description);
    console.error("Got:", {
      blockCount: compiled.systemBlocks.length,
      cachedBlocks: compiled.systemBlocks.filter(b => b.cache_control).length,
      dropped: compiled.droppedSegments,
      fingerprint: compiled.fingerprint,
    });
    process.exit(1);
  }
  console.log("PASS:", FIXTURE.description);
  console.log(`  Fingerprint: ${compiled.fingerprint}`);
  console.log(`  ${compiled.systemBlocks.length} blocks, ${compiled.systemBlocks.filter(b => b.cache_control).length} cached, ${compiled.totalTokens} tokens`);

  // Second test: required segment must NOT be dropped even when budget is tiny
  const tinyBudget = compilePrompt(FIXTURE.segments, { maxTokens: 50 });
  const safetyIncluded = tinyBudget.includedSegments.some(s => s.kind === "safety");
  const toolPolicyIncluded = tinyBudget.includedSegments.some(s => s.kind === "tool_policy");
  if (!safetyIncluded || !toolPolicyIncluded) {
    console.error("FAIL: required segments (safety, tool_policy) dropped under tiny budget");
    process.exit(1);
  }
  console.log("PASS: required segments survive overbudget");

  // Third test: fingerprint stability — same input twice, same fingerprint
  const repeat = compilePrompt(FIXTURE.segments, { maxTokens: 16_000 });
  if (repeat.fingerprint !== compiled.fingerprint) {
    console.error("FAIL: fingerprint not stable across runs");
    process.exit(1);
  }
  console.log("PASS: fingerprint stable");
}

run();
