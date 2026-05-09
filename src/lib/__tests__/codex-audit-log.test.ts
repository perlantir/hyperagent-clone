// P66b — codex_audit_log tests with a fake Postgres pool.
//
// Exercises:
//   - emitAuditLog inserts a row with the right fields
//   - emitAuditLog redacts secrets in `details`
//   - listAuditLog filters by userId / orgId / runId / severity / time
//   - pruneOldAuditLog respects severity-aware TTL (security never deleted)
//   - emitAuditLog swallows DB errors (best-effort write)

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

interface Row {
  id: number;
  userId: string | null;
  orgId: string | null;
  companionId: string | null;
  runId: string | null;
  providerMode: string | null;
  event: string;
  severity: string;
  details: any;
  at: number;
}

const rows: Row[] = [];
let nextId = 1;
let throwOnInsert = false;

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/CREATE TABLE/.test(sql) || /CREATE INDEX/.test(sql)) return { rows: [], rowCount: 0 };

    if (/INSERT INTO codex_audit_log/.test(sql)) {
      if (throwOnInsert) throw new Error("simulated DB outage");
      const [userId, orgId, companionId, runId, providerMode, event, severity, detailsJson, at] = params;
      rows.push({
        id: nextId++,
        userId, orgId, companionId, runId, providerMode, event, severity,
        details: typeof detailsJson === "string" ? JSON.parse(detailsJson) : detailsJson,
        at: Number(at),
      });
      return { rows: [], rowCount: 1 };
    }

    if (/FROM codex_audit_log/.test(sql) && /^\s*SELECT/i.test(sql)) {
      // Resolve each placeholder by scanning the SQL for `<col> = $N`
      // / `<col> >= $N` / `<col> < $N` patterns. The helper's WHERE
      // builder always uses these exact shapes, so this matcher
      // covers every legitimate query without trying to be a real
      // parser.
      const resolveArg = (re: RegExp): any | null => {
        const m = sql.match(re);
        if (!m) return null;
        return params[Number(m[1]) - 1];
      };
      const userArg = resolveArg(/"userId" = \$(\d+)/);
      const orgArg = resolveArg(/"orgId" = \$(\d+)/);
      const runArg = resolveArg(/"runId" = \$(\d+)/);
      const sevArg = resolveArg(/"severity" = \$(\d+)/);
      const sinceArg = resolveArg(/"at" >= \$(\d+)/);
      const beforeArg = resolveArg(/"at" < \$(\d+)/);
      const filtered = rows.filter((r) => {
        if (userArg !== null && r.userId !== userArg) return false;
        if (orgArg !== null && r.orgId !== orgArg) return false;
        if (runArg !== null && r.runId !== runArg) return false;
        if (sevArg !== null && r.severity !== sevArg) return false;
        if (sinceArg !== null && r.at < Number(sinceArg)) return false;
        if (beforeArg !== null && r.at >= Number(beforeArg)) return false;
        return true;
      });
      filtered.sort((a, b) => b.at - a.at || b.id - a.id);
      // Final placeholder is the LIMIT.
      const limitMatch = sql.match(/LIMIT \$(\d+)/);
      const limit = limitMatch ? Number(params[Number(limitMatch[1]) - 1]) : 5000;
      return { rows: filtered.slice(0, limit), rowCount: filtered.length };
    }

    if (/DELETE FROM codex_audit_log/.test(sql)) {
      const cutoff = Number(params[0]);
      let deleted = 0;
      const isInfoBranch = /'info','warn'/.test(sql);
      const isErrorBranch = /'error'/.test(sql) && !isInfoBranch;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.at >= cutoff) continue;
        if (isInfoBranch && (r.severity === "info" || r.severity === "warn")) {
          rows.splice(i, 1); deleted++;
        } else if (isErrorBranch && r.severity === "error") {
          rows.splice(i, 1); deleted++;
        }
      }
      return { rows: [], rowCount: deleted };
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
  emitAuditLog,
  listAuditLog,
  pruneOldAuditLog,
} = require("../codex/audit-log");

(async () => {
  // ─── basic emit ────────────────────────────────────────────────────
  const baseTime = 1_000_000;
  await emitAuditLog({
    userId: "u1", orgId: "o1",
    runId: "run_abc",
    providerMode: "codexChatGPTLocal",
    event: "run/created",
    severity: "info",
    details: { threadId: "t1", transport: "local-stdio" },
    now: baseTime,
  });
  pass("emit inserts a row",
    rows.length === 1 && rows[0].userId === "u1" && rows[0].event === "run/created");
  pass("severity stored",
    rows[0].severity === "info");
  pass("details stored as JSON",
    rows[0].details?.threadId === "t1" && rows[0].details?.transport === "local-stdio");

  // ─── redaction defense-in-depth ────────────────────────────────────
  await emitAuditLog({
    userId: "u1",
    event: "run/failed",
    severity: "error",
    details: {
      authorization: "Bearer eyJabc.def.ghi-1234567890",
      apiKey: "sk-secret-deadbeef00000000",
      message: "harmless",
      nested: { refresh_token: "rtok_xxx", ok: true },
    },
    now: baseTime + 1,
  });
  const redacted = rows.find(r => r.event === "run/failed");
  pass("redaction strips authorization field",
    typeof redacted?.details?.authorization === "string"
    && /\[REDACTED/i.test(redacted.details.authorization));
  pass("redaction strips apiKey field",
    typeof redacted?.details?.apiKey === "string"
    && /\[REDACTED/i.test(redacted.details.apiKey));
  pass("redaction walks nested objects",
    typeof redacted?.details?.nested?.refresh_token === "string"
    && /\[REDACTED/i.test(redacted.details.nested.refresh_token));
  pass("redaction preserves harmless fields",
    redacted?.details?.message === "harmless"
    && redacted?.details?.nested?.ok === true);

  // ─── list filters ─────────────────────────────────────────────────
  await emitAuditLog({
    userId: "u2", event: "run/completed", severity: "info",
    now: baseTime + 2,
  });
  const u1List = await listAuditLog({ userId: "u1" });
  pass("list filters by userId",
    u1List.length === 2 && u1List.every((r: any) => r.userId === "u1"));
  const errOnly = await listAuditLog({ userId: "u1", severity: "error" });
  pass("list filters by severity",
    errOnly.length === 1 && errOnly[0].event === "run/failed");

  // ─── time filtering ───────────────────────────────────────────────
  const fresh = await listAuditLog({ sinceMs: baseTime + 1 });
  pass("list filters by sinceMs",
    fresh.length === 2 && fresh.every((r: any) => r.at >= baseTime + 1));

  // ─── prune severity-aware TTL ─────────────────────────────────────
  // Add a security row that should NEVER be pruned.
  await emitAuditLog({
    userId: "u-sec", event: "csrf/blocked", severity: "security",
    now: baseTime - 10_000_000_000, // very old
  });
  // Prune everything older than baseTime.
  const pruneRes = await pruneOldAuditLog({
    infoOlderThanMs: 0, // means cutoff = now (which we set to baseTime + 5)
    errorOlderThanMs: 0,
    now: baseTime + 5,
  });
  pass("prune deletes info+warn rows older than cutoff",
    pruneRes.infoDeleted >= 2);
  pass("prune deletes error rows older than cutoff",
    pruneRes.errorDeleted === 1);
  pass("security row survives prune",
    rows.some((r: any) => r.severity === "security" && r.event === "csrf/blocked"));

  // ─── best-effort write: DB error swallowed ────────────────────────
  throwOnInsert = true;
  let threw = false;
  try {
    await emitAuditLog({
      userId: "u-err", event: "run/created", severity: "info",
      now: baseTime + 100,
    });
  } catch {
    threw = true;
  }
  pass("emitAuditLog swallows DB errors", threw === false);
  throwOnInsert = false;

  if (failed > 0) {
    console.error(`\n${failed} audit-log test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-audit-log tests passed");
})();
