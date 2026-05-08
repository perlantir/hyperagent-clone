// P25 fixture tests for cosine similarity (pure math; no API calls).

import { cosineSimilarity } from "../cosine";

function pass(label: string, cond: boolean) {
  if (!cond) { console.error("FAIL:", label); process.exit(1); }
  console.log("PASS:", label);
}

// Identical vectors: similarity 1
const a = [1, 2, 3];
pass("identical vectors → 1", Math.abs(cosineSimilarity(a, a) - 1) < 1e-9);

// Orthogonal vectors: similarity 0
pass("orthogonal vectors → 0", Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 1e-9);

// Opposite vectors: similarity -1
pass("opposite vectors → -1", Math.abs(cosineSimilarity([1, 0], [-1, 0]) - (-1)) < 1e-9);

// Scaled vectors: similarity unchanged
pass("scaled vectors → 1", Math.abs(cosineSimilarity([1, 2, 3], [10, 20, 30]) - 1) < 1e-9);

// Empty vectors → 0
pass("empty → 0", cosineSimilarity([], []) === 0);

// Mismatched lengths → 0
pass("mismatched lengths → 0", cosineSimilarity([1, 2], [1, 2, 3]) === 0);

// Realistic 3-dim semantic-ish similarity
const v1 = [0.5, 0.7, 0.1];
const v2 = [0.6, 0.7, 0.2];
const sim = cosineSimilarity(v1, v2);
pass("similar vectors → high score", sim > 0.95 && sim < 1);

// Dissimilar vectors → low score
const v3 = [0.1, 0.1, 0.9];
pass("dissimilar vectors → lower score", cosineSimilarity(v1, v3) < cosineSimilarity(v1, v2));

console.log("");
console.log("All embedding tests pass.");
