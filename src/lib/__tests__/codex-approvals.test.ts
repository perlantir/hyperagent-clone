// P59 — codex approval rendezvous tests.
//
// Validates the DB-backed approval store:
//   - createApproval inserts a pending row
//   - submitDecision is ownership-scoped (rejects wrong userId)
//   - submitDecision is one-shot (subsequent decisions ignored)
//   - pollDecision returns the decision when set
//   - pollDecision returns "timeout" when no decision arrives in time
//   - pruneOldApprovals removes rows older than the cutoff

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

// In-memory approvals store backed by a fake pool.
interface Row {
  approvalId: string;
  threadId: string;
  userId: string;
  kind: string;
  summary: string;
  detail?: string | null;
  decision?: string | null;
  decidedAt?: number | null;
  createdAt: number;
}
const rows: Record<string, Row> = {};

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/CREATE TABLE/.test(sql) || /CREATE INDEX/.test(sql)) return { rows: [] };
    if (/INSERT INTO codex_approvals/.test(sql)) {
      const [approvalId, threadId, userId, kind, summary, detail, createdAt] = params;
      if (rows[approvalId]) return { rows: [], rowCount: 0 };
      rows[approvalId] = { approvalId, threadId, userId, kind, summary, detail, createdAt, decision: null };
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT decision FROM codex_approvals/.test(sql)) {
      const r = rows[params[0]];
      return { rows: r ? [{ decision: r.decision || null }] : [] };
    }
    if (/UPDATE codex_approvals/.test(sql)) {
      const [decision, decidedAt, approvalId, userId] = params;
      const r = rows[approvalId];
      if (!r || r.userId !== userId || r.decision) return { rows: [], rowCount: 0 };
      r.decision = decision;
      r.decidedAt = decidedAt;
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM codex_approvals/.test(sql)) {
      const cutoff = params[0];
      let n = 0;
      for (const id of Object.keys(rows)) {
        if (rows[id].createdAt < cutoff) { delete rows[id]; n++; }
      }
      return { rows: [], rowCount: n };
    }
    return { rows: [] };
  },
};

const dbPath = require.resolve("../db");
(require as any).cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: () => fakePool },
};

const {
  createApproval, pollDecision, submitDecision, pruneOldApprovals,
} = require("../codex/approvals-store");

(async () => {
  // ─── create + read ────────────────────────────────────────────────
  await createApproval({
    approvalId: "a1", threadId: "t1", userId: "u1",
    kind: "command", summary: "Run ls", detail: "ls /tmp",
  });
  pass("approval row created",
    rows["a1"]?.userId === "u1" && rows["a1"]?.decision === null);

  // ─── submit decision: ownership-scoped ────────────────────────────
  const wrongOwner = await submitDecision("a1", "u-other", "accept");
  pass("submitDecision rejects wrong owner",
    wrongOwner === false && rows["a1"]?.decision === null);

  const ok = await submitDecision("a1", "u1", "accept");
  pass("submitDecision accepts correct owner", ok === true);
  pass("approval row now has decision",
    rows["a1"]?.decision === "accept" && rows["a1"]?.decidedAt !== null);

  // ─── one-shot: subsequent submit fails ────────────────────────────
  const second = await submitDecision("a1", "u1", "decline");
  pass("submitDecision is one-shot (ignores later decision)",
    second === false);
  pass("decision unchanged after second submit",
    rows["a1"]?.decision === "accept");

  // ─── pollDecision returns the decision when set ───────────────────
  await createApproval({
    approvalId: "a2", threadId: "t1", userId: "u1",
    kind: "file", summary: "Edit file",
  });
  // Set the decision in the background.
  setTimeout(() => { void submitDecision("a2", "u1", "decline"); }, 200);
  const d = await pollDecision("a2", 2000, 50);
  pass("pollDecision returns the decision when set", d === "decline");

  // ─── pollDecision times out ───────────────────────────────────────
  await createApproval({
    approvalId: "a3", threadId: "t1", userId: "u1",
    kind: "command", summary: "Slow approval",
  });
  const t0 = Date.now();
  const dt = await pollDecision("a3", 250, 50);
  const elapsed = Date.now() - t0;
  pass("pollDecision returns 'timeout' on timeout", dt === "timeout");
  pass("pollDecision honors the timeout window (≥240ms)", elapsed >= 240);

  // ─── pruneOldApprovals deletes rows older than the cutoff ────────
  // Manually backdate one row.
  rows["a1"].createdAt = Date.now() - 48 * 60 * 60 * 1000;
  const removed = await pruneOldApprovals(24 * 60 * 60 * 1000);
  pass("pruneOldApprovals removes stale rows", removed === 1);
  pass("pruneOldApprovals leaves recent rows alone",
    !!rows["a2"] && !!rows["a3"]);

  // ─── unknown approvalId → submitDecision returns false ────────────
  const unknown = await submitDecision("nope", "u1", "accept");
  pass("submitDecision returns false for unknown approvalId",
    unknown === false);

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll approvals tests passed.");
})();
