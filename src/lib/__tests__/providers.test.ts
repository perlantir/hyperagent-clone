// P29 hardening — fixture tests for loop detection + truncation.

import { detectLoop, truncateMessages } from "../providers";

// =================== LOOP DETECTION ===================

function pass(label: string, cond: boolean) {
  if (!cond) { console.error("FAIL:", label); process.exit(1); }
  console.log("PASS:", label);
}

// 1. Identical signature 3 times = loop
const identical = detectLoop([
  { text: "", toolSig: "web_search:{q:hi}" },
  { text: "", toolSig: "web_search:{q:hi}" },
  { text: "", toolSig: "web_search:{q:hi}" },
]);
pass("identical pattern detected", identical.loop && identical.reason === "identical");

// 2. Alternating ABAB = loop
const alternating = detectLoop([
  { text: "", toolSig: "web_search:{q:a}" },
  { text: "", toolSig: "browser_navigate:{url:b}" },
  { text: "", toolSig: "web_search:{q:a}" },
  { text: "", toolSig: "browser_navigate:{url:b}" },
]);
pass("alternating pattern detected", alternating.loop && alternating.reason === "alternating");

// 3. Near-duplicate (95% similar) = loop
const nearDup = detectLoop([
  { text: "", toolSig: "web_search:{q:weather forecast tomorrow}" },
  { text: "", toolSig: "web_search:{q:weather forecast tomrrow}" },     // typo
  { text: "", toolSig: "web_search:{q:weather forecast tommorrow}" },   // another typo
]);
pass("near-duplicate pattern detected", nearDup.loop && nearDup.reason === "near_duplicate");

// 4. Distinct sigs with text = NOT a loop (agent is making progress)
const progress = detectLoop([
  { text: "Found result A", toolSig: "web_search:{q:a}" },
  { text: "Now searching B", toolSig: "web_search:{q:b}" },
  { text: "Found C", toolSig: "web_search:{q:c}" },
]);
pass("genuine progress NOT flagged as loop", !progress.loop);

// 5. Distinct sigs without text = NOT a loop (agent is exploring)
const exploring = detectLoop([
  { text: "", toolSig: "web_search:{q:apples}" },
  { text: "", toolSig: "browser_navigate:{url:cnn}" },
  { text: "", toolSig: "code_interpreter:{code:print(1)}" },
]);
pass("distinct exploration NOT flagged as loop", !exploring.loop);

// 6. Empty signatures don't trigger
const empty = detectLoop([
  { text: "", toolSig: "" },
  { text: "", toolSig: "" },
  { text: "", toolSig: "" },
]);
pass("empty signatures NOT flagged as loop", !empty.loop);

// =================== TRUNCATION ===================

// Build messages that exceed 100 tokens and verify truncation summary
const fakeText = "x".repeat(500); // ~125 tokens
const longMessages = [
  { role: "user", content: "Original task: do the thing" },
  { role: "assistant", content: [{ type: "tool_use", name: "web_search", input: { q: "a" } }] },
  { role: "user", content: [{ type: "tool_result", content: fakeText }] },
  { role: "assistant", content: [{ type: "tool_use", name: "web_search", input: { q: "b" } }] },
  { role: "user", content: [{ type: "tool_result", content: fakeText }] },
  { role: "assistant", content: [{ type: "tool_use", name: "browser_navigate", input: { url: "x" } }] },
  { role: "user", content: [{ type: "tool_result", content: fakeText }] },
  { role: "assistant", content: "Here's what I found" },
  { role: "user", content: "Tell me more" },
];

const truncResult = truncateMessages(longMessages, 100);
pass("truncation removed messages", truncResult.dropped > 0);
pass("truncation produced summary", !!truncResult.summary && truncResult.summary.length > 10);
pass("truncation preserves first user msg", truncResult.messages[0].content.includes("Original task"));
pass("truncation preserves last user msg", truncResult.messages[truncResult.messages.length - 1].content === "Tell me more");

// Summary should mention tool counts
const hasToolCensus = /\d+× (web_search|browser_navigate)/.test(truncResult.summary || "");
pass("truncation summary lists tool counts", hasToolCensus);

console.log("");
console.log("All loop-detection + truncation tests pass.");
