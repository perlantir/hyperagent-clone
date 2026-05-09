// P66d — runs-store tests with a fake Postgres pool.
//
// Covers:
//   - createRun mints opaque runId and inserts in state="queued"
//   - getRun is user-scoped (foreign user → null)
//   - transitionRunState enforces expectedFrom guards
//   - bumpRunLastEventSeq monotonic
//   - listActiveRunsForUser excludes terminal states
//   - createApprovalRequest + decideApproval atomic
//   - decideApproval rejects wrong user, already_decided, expired
//   - listPendingApprovalsForUser scoped + filtered
//   - expirePastDueApprovals flips timed_out

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

interface State { runs: any[]; approvals: any[] }
const state: State = { runs: [], approvals: [] };

function applyExpectedStateFilter(sql: string, params: any[], states: any[]): any[] {
  // Match the WHERE "state" IN ($N,$N+1,…) clause.
  const m = sql.match(/"state" IN \(([^)]+)\)/);
  if (!m) return states;
  const placeholders = m[1].split(",").map((s) => s.trim());
  const expected = placeholders.map((p) => params[Number(p.slice(1)) - 1]);
  return expected;
}

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [], rowCount: 0 };

    // ─── codex_runs INSERT ─────────────────────────────────────────
    if (/INSERT INTO codex_runs/.test(sql)) {
      const [runId, userId, orgId, threadId, agentId, companionId, providerMode, startedAt, policySnapshot] = params;
      state.runs.push({
        runId, userId, orgId, threadId, agentId, companionId, providerMode,
        state: "queued", lastEventSeq: 0,
        startedAt: Number(startedAt), endedAt: null, lastError: null,
        policySnapshot: typeof policySnapshot === "string" ? JSON.parse(policySnapshot) : policySnapshot,
        budgetMicroUsdSeen: 0,
      });
      return { rows: [], rowCount: 1 };
    }

    if (/SELECT \* FROM codex_runs WHERE "runId"=\$1 AND "userId"=\$2/.test(sql)) {
      const r = state.runs.find((r) => r.runId === params[0] && r.userId === params[1]);
      return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
    }
    if (/SELECT \* FROM codex_runs WHERE "runId"=\$1$/.test(sql)) {
      const r = state.runs.find((r) => r.runId === params[0]);
      return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
    }

    // UPDATE codex_runs SET state ...
    if (/UPDATE codex_runs SET/.test(sql) && /"state" = \$2/.test(sql)) {
      const [runId, newState] = params;
      const r = state.runs.find((r) => r.runId === runId);
      if (!r) return { rows: [], rowCount: 0 };
      // expectedFrom check
      if (/"state" IN/.test(sql)) {
        const expected = applyExpectedStateFilter(sql, params, []);
        if (!expected.includes(r.state)) return { rows: [], rowCount: 0 };
      }
      r.state = newState;
      // optional endedAt / lastError
      const endedAtMatch = sql.match(/"endedAt" = \$(\d+)/);
      if (endedAtMatch) r.endedAt = Number(params[Number(endedAtMatch[1]) - 1]);
      const errMatch = sql.match(/"lastError" = \$(\d+)/);
      if (errMatch) r.lastError = params[Number(errMatch[1]) - 1];
      return { rows: [], rowCount: 1 };
    }

    if (/UPDATE codex_runs SET "lastEventSeq"/.test(sql)) {
      const [runId, seq] = params;
      const r = state.runs.find((r) => r.runId === runId);
      if (!r) return { rows: [], rowCount: 0 };
      r.lastEventSeq = Math.max(r.lastEventSeq, Number(seq));
      return { rows: [], rowCount: 1 };
    }

    if (/SELECT \* FROM codex_runs/.test(sql) && /"userId" = \$1/.test(sql) && /"state" IN/.test(sql)) {
      const [userId] = params;
      const filtered = state.runs
        .filter((r) =>
          r.userId === userId
          && ["queued", "dispatched", "running", "approval_pending", "cancelling"].includes(r.state),
        )
        .sort((a, b) => b.startedAt - a.startedAt);
      const limit = Number(params[1] || 50);
      return { rows: filtered.slice(0, limit), rowCount: filtered.length };
    }

    // ─── codex_run_approvals ───────────────────────────────────────
    if (/INSERT INTO codex_run_approvals/.test(sql)) {
      const [approvalId, runId, userId, kind, methodName, summary, payloadJson, requestedAt, companionId, expiresAt] = params;
      state.approvals.push({
        approvalId, runId, userId, kind, methodName, summary,
        redactedPayload: typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson,
        requestedAt: Number(requestedAt),
        decidedAt: null, decision: null, decidedBy: null, decisionSource: null,
        companionId, expiresAt: expiresAt ? Number(expiresAt) : null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT \* FROM codex_run_approvals WHERE "approvalId" = \$1$/.test(sql)) {
      const r = state.approvals.find((r) => r.approvalId === params[0]);
      return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
    }
    if (/UPDATE codex_run_approvals/.test(sql) && /"decidedAt" = \$4/.test(sql)) {
      const [approvalId, userId, _decisionA, decidedAt, decision, source] = params;
      const r = state.approvals.find(
        (r) => r.approvalId === approvalId
            && r.userId === userId
            && r.decidedAt === null
            && (r.expiresAt === null || r.expiresAt > Number(decidedAt)),
      );
      if (!r) return { rows: [], rowCount: 0 };
      r.decidedAt = Number(decidedAt);
      r.decision = decision;
      r.decidedBy = userId;
      r.decisionSource = source;
      return { rows: [r], rowCount: 1 };
    }
    if (/SELECT \* FROM codex_run_approvals WHERE "approvalId" = \$1 AND "userId" = \$2/.test(sql)) {
      const r = state.approvals.find((r) => r.approvalId === params[0] && r.userId === params[1]);
      return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
    }
    if (/SELECT \* FROM codex_run_approvals/.test(sql) && /"userId" = \$1 AND "decidedAt" IS NULL/.test(sql)) {
      const [userId] = params;
      const rs = state.approvals
        .filter((r) => r.userId === userId && r.decidedAt === null)
        .sort((a, b) => a.requestedAt - b.requestedAt);
      const limit = Number(params[1] || 50);
      return { rows: rs.slice(0, limit), rowCount: rs.length };
    }
    if (/UPDATE codex_run_approvals/.test(sql) && /'timed_out'/.test(sql)) {
      const [now] = params;
      let n = 0;
      for (const a of state.approvals) {
        if (a.decidedAt === null && a.expiresAt !== null && a.expiresAt <= Number(now)) {
          a.decidedAt = Number(now);
          a.decision = "timed_out";
          a.decisionSource = "timeout";
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }

    return { rows: [], rowCount: 0 };
  },
};

const dbPath = require.resolve("../db");
(require as any).cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: () => fakePool },
};

const {
  createRun, getRun, transitionRunState, bumpRunLastEventSeq,
  listActiveRunsForUser,
  createApprovalRequest, decideApproval, getApproval,
  listPendingApprovalsForUser, expirePastDueApprovals,
} = require("../codex/runs-store");

(async () => {
  // ─── createRun ────────────────────────────────────────────────────
  const r1 = await createRun({
    userId: "u1", threadId: "t1",
    providerMode: "codexChatGPTCompanion",
    companionId: "cmp_x",
    policySnapshot: { approvalPolicy: { require: ["command"] } },
    now: 1000,
  });
  pass("createRun mints runId starting with run_",
    typeof r1.runId === "string" && r1.runId.startsWith("run_"));
  pass("createRun starts in state=queued",
    r1.state === "queued");
  pass("createRun policySnapshot stored",
    Array.isArray(r1.policySnapshot?.approvalPolicy?.require)
    && r1.policySnapshot.approvalPolicy.require[0] === "command");

  // ─── getRun ───────────────────────────────────────────────────────
  const got = await getRun({ runId: r1.runId, userId: "u1" });
  pass("getRun returns own row", got?.runId === r1.runId);
  const foreign = await getRun({ runId: r1.runId, userId: "u-other" });
  pass("getRun scoped to userId", foreign === null);

  // ─── transitionRunState ──────────────────────────────────────────
  const ok1 = await transitionRunState({
    runId: r1.runId, expectedFrom: ["queued"], to: "dispatched",
  });
  pass("transition queued → dispatched ok", ok1 === true);

  // Wrong expectedFrom → no-op
  const blocked = await transitionRunState({
    runId: r1.runId, expectedFrom: ["queued"], to: "running",
  });
  pass("transition refused when expectedFrom mismatch",
    blocked === false);

  const ok2 = await transitionRunState({
    runId: r1.runId, expectedFrom: ["dispatched"], to: "running",
  });
  pass("transition dispatched → running ok", ok2 === true);

  // Terminal transition with endedAt
  const ok3 = await transitionRunState({
    runId: r1.runId, expectedFrom: ["running", "approval_pending"],
    to: "completed", endedAt: 9999,
  });
  pass("transition running → completed sets endedAt",
    ok3 === true && state.runs.find((r: any) => r.runId === r1.runId)?.endedAt === 9999);

  // ─── bumpRunLastEventSeq ─────────────────────────────────────────
  await bumpRunLastEventSeq({ runId: r1.runId, sequence: 5 });
  await bumpRunLastEventSeq({ runId: r1.runId, sequence: 3 });  // monotonic; should not lower
  const cur = await getRun({ runId: r1.runId, userId: "u1" });
  pass("bumpRunLastEventSeq monotonic (max)",
    cur?.lastEventSeq === 5);

  // ─── listActiveRunsForUser excludes terminal ─────────────────────
  const r2 = await createRun({ userId: "u1", threadId: "t2", providerMode: "codexChatGPTCompanion", now: 2000 });
  await createRun({ userId: "u2", threadId: "t99", providerMode: "codexChatGPTCompanion", now: 2500 });
  const active = await listActiveRunsForUser({ userId: "u1" });
  pass("listActive returns the not-yet-terminal r2",
    active.some((r: any) => r.runId === r2.runId)
    && !active.some((r: any) => r.runId === r1.runId));
  pass("listActive userId-scoped",
    !active.some((r: any) => r.userId === "u2"));

  // ─── createApprovalRequest + decideApproval ──────────────────────
  const a1 = await createApprovalRequest({
    runId: r2.runId, userId: "u1",
    kind: "command", methodName: "item/commandExecution/requestApproval",
    summary: "Run: ls /tmp",
    redactedPayload: { command: "ls /tmp" },
    companionId: "cmp_x",
    ttlMs: 60_000,
    now: 3000,
  });
  pass("approval id minted", typeof a1.approvalId === "string" && a1.approvalId.startsWith("apr_"));
  pass("approval is pending", a1.decidedAt === null);
  pass("approval expiresAt set", a1.expiresAt === 60_000 + 3000);

  const dec1 = await decideApproval({
    approvalId: a1.approvalId, userId: "u1", decision: "approved", now: 3500,
  });
  pass("decideApproval succeeds",
    (dec1 as any).ok === true && (dec1 as any).row?.decision === "approved");

  // Re-decide is rejected
  const dec2 = await decideApproval({
    approvalId: a1.approvalId, userId: "u1", decision: "denied", now: 4000,
  });
  pass("decideApproval refuses re-decide",
    (dec2 as any).ok === false && (dec2 as any).reason === "already_decided");

  // Wrong user
  const a2 = await createApprovalRequest({
    runId: r2.runId, userId: "u1", kind: "file",
    methodName: "item/fileChange/requestApproval",
    summary: "Edit foo.ts", ttlMs: 60_000, now: 5000,
  });
  const decWrong = await decideApproval({
    approvalId: a2.approvalId, userId: "u-other", decision: "approved", now: 5100,
  });
  pass("decideApproval refuses wrong user",
    (decWrong as any).ok === false && (decWrong as any).reason === "wrong_user");

  // Expired
  const a3 = await createApprovalRequest({
    runId: r2.runId, userId: "u1", kind: "tool",
    methodName: "item/tool/requestUserInput",
    summary: "tool input", ttlMs: 100, now: 6000,
  });
  const decExp = await decideApproval({
    approvalId: a3.approvalId, userId: "u1", decision: "approved", now: 7000,
  });
  pass("decideApproval refuses expired",
    (decExp as any).ok === false && (decExp as any).reason === "expired");

  // ─── listPendingApprovalsForUser ─────────────────────────────────
  // listPending includes anything with decidedAt IS NULL, even if
  // expiresAt has passed. The expirer cron flips expired rows to
  // timed_out separately; until then they show up in the inbox.
  // We assert the decided one (a1) is excluded but a2 + a3 are present.
  const pending = await listPendingApprovalsForUser({ userId: "u1" });
  pass("listPending excludes decided rows",
    pending.every((p: any) => p.approvalId !== a1.approvalId));
  pass("listPending includes a2 (still pending)",
    pending.some((p: any) => p.approvalId === a2.approvalId));
  pass("listPending includes a3 (expired but not yet timed-out flipped)",
    pending.some((p: any) => p.approvalId === a3.approvalId));

  // ─── expirePastDueApprovals ──────────────────────────────────────
  // a3 should be picked up (its expiresAt was already past now=7000).
  // Re-create one explicitly.
  const a4 = await createApprovalRequest({
    runId: r2.runId, userId: "u1", kind: "command",
    methodName: "item/commandExecution/requestApproval",
    summary: "expired-soon", ttlMs: 50, now: 8000,
  });
  const expN = await expirePastDueApprovals({ now: 8200 });
  pass("expirePastDueApprovals flips overdue rows",
    expN >= 1);
  const a4after = await getApproval({ approvalId: a4.approvalId, userId: "u1" });
  pass("expired approval has decision=timed_out",
    a4after?.decision === "timed_out" && a4after?.decisionSource === "timeout");

  if (failed > 0) {
    console.error(`\n${failed} runs-store test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-runs-store tests passed");
})();
