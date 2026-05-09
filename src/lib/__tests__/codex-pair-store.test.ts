// P65 — pair store tests.
//
// In-memory pool fake; verifies start / claim / status / revoke /
// heartbeat semantics + scoping + redaction-by-construction (we never
// store plaintext pair codes / session secrets).

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

interface SessionRow {
  id: string;
  userId: string;
  orgId: string | null;
  pairCodeHash: string;
  sessionId?: string | null;
  sessionSecretHash?: string | null;
  companionBaseUrl?: string | null;
  companionInfo?: any;
  status: string;
  createdAt: number;
  claimedAt?: number | null;
  lastHeartbeatAt?: number | null;
  expiresAt: number;
  revokedAt?: number | null;
}

const rows: Record<string, SessionRow> = {};

const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    if (/CREATE TABLE/.test(sql) || /CREATE INDEX/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO codex_pair_sessions/.test(sql)) {
      const [id, userId, orgId, pairCodeHash, createdAt, expiresAt] = params;
      rows[id] = {
        id, userId, orgId,
        pairCodeHash,
        status: "pending",
        createdAt: Number(createdAt),
        expiresAt: Number(expiresAt),
      };
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM codex_pair_sessions/.test(sql)) {
      const [userId, now] = params;
      let n = 0;
      for (const id of Object.keys(rows)) {
        const r = rows[id];
        if (r.userId === userId && (r.status === "pending" || r.status === "expired") && r.expiresAt < Number(now)) {
          delete rows[id];
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }
    if (/SELECT "id","userId","orgId","pairCodeHash"/.test(sql)) {
      const codeHash = params[0];
      const matches = Object.values(rows).filter(r => r.pairCodeHash === codeHash).sort((a, b) => b.createdAt - a.createdAt);
      return { rows: matches.slice(0, 1), rowCount: matches.length };
    }
    if (/UPDATE codex_pair_sessions[\s\S]*SET "status"='claimed'/.test(sql)) {
      const [id, sessionSecretHash, companionBaseUrl, companionInfo, claimedAt, expiresAt] = params;
      const row = rows[id];
      if (!row || row.status !== "pending") return { rows: [], rowCount: 0 };
      row.status = "claimed";
      row.sessionSecretHash = sessionSecretHash;
      row.companionBaseUrl = companionBaseUrl;
      row.companionInfo = companionInfo ? JSON.parse(companionInfo) : null;
      row.claimedAt = Number(claimedAt);
      row.lastHeartbeatAt = Number(claimedAt);
      row.expiresAt = Number(expiresAt);
      row.sessionId = id;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE codex_pair_sessions SET "status"='expired'/.test(sql)) {
      const id = params[0];
      const row = rows[id];
      if (row && row.status === "pending") row.status = "expired";
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE codex_pair_sessions[\s\S]*SET "status"='revoked'/.test(sql)) {
      const [id, userId, now] = params;
      const row = rows[id];
      if (row && row.userId === userId && row.status !== "revoked") {
        row.status = "revoked";
        row.revokedAt = Number(now);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT "id","userId","status","companionBaseUrl"/.test(sql)) {
      const r = rows[params[0]];
      return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/SELECT "id","status","sessionSecretHash"/.test(sql)) {
      const r = rows[params[0]];
      return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/SELECT "id","userId","orgId","status","sessionSecretHash"/.test(sql)) {
      const r = rows[params[0]];
      return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/UPDATE codex_pair_sessions[\s\S]*SET "lastHeartbeatAt"/.test(sql)) {
      const [id, now, info] = params;
      const r = rows[id];
      if (r) {
        r.lastHeartbeatAt = Number(now);
        if (info) r.companionInfo = JSON.parse(info);
      }
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT COUNT/.test(sql)) {
      return { rows: [{ n: 0 }], rowCount: 1 };
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
  startPairSession, claimPairSession, getPairStatus,
  revokePairSession, heartbeatPairSession, authenticateCompanion,
  validateCompanionBaseUrl, PairingError,
  PAIR_CODE_TTL_MS, SESSION_ONLINE_GRACE_MS,
} = require("../codex/pair-store");

(async () => {
  // ─── start ─────────────────────────────────────────────────────────
  const started = await startPairSession({ userId: "u1" });
  pass("startPairSession returns sessionId", typeof started.sessionId === "string" && started.sessionId.startsWith("ses_"));
  pass("startPairSession returns hex pair-code (192-bit)",
    typeof started.pairCode === "string" && started.pairCode.length === 48 && /^[0-9a-f]+$/.test(started.pairCode));
  pass("startPairSession sets expiresAt to PAIR_CODE_TTL_MS in future",
    started.expiresAt > Date.now() && started.expiresAt <= Date.now() + PAIR_CODE_TTL_MS + 100);
  pass("DB row created in pending state",
    rows[started.sessionId]?.status === "pending");
  // Pair code itself is NOT in the DB.
  pass("pair-code never stored in plaintext",
    Object.values(rows).every(r => r.pairCodeHash !== started.pairCode));

  // ─── claim ─────────────────────────────────────────────────────────
  const claim = await claimPairSession({
    userId: "u1",
    pairCode: started.pairCode,
    companionBaseUrl: "http://127.0.0.1:8390",
    companionInfo: { packageVersion: "0.1.0", platform: "linux" },
  });
  pass("claim returns sessionId", claim.sessionId === started.sessionId);
  pass("claim returns sessionSecret (256-bit hex)",
    typeof claim.sessionSecret === "string" && claim.sessionSecret.length === 64);
  pass("claim flips status → claimed",
    rows[claim.sessionId]?.status === "claimed");
  pass("session secret never stored in plaintext",
    rows[claim.sessionId]?.sessionSecretHash !== claim.sessionSecret
    && (rows[claim.sessionId]?.sessionSecretHash?.length === 64));

  // Second claim must fail.
  let secondClaimErr: any = null;
  try {
    await claimPairSession({ userId: "u1", pairCode: started.pairCode, companionBaseUrl: "http://127.0.0.1:8390" });
  } catch (e: any) { secondClaimErr = e; }
  pass("second claim refused as already_claimed",
    secondClaimErr instanceof PairingError && secondClaimErr.code === "already_claimed");

  // ─── wrong-user claim ──────────────────────────────────────────────
  const startedB = await startPairSession({ userId: "uA" });
  let wrongUserErr: any = null;
  try {
    await claimPairSession({ userId: "uB", pairCode: startedB.pairCode, companionBaseUrl: "http://127.0.0.1:8391" });
  } catch (e: any) { wrongUserErr = e; }
  pass("wrong-user claim refused",
    wrongUserErr instanceof PairingError && wrongUserErr.code === "wrong_user");

  // ─── companion URL validation ─────────────────────────────────────
  let nonLoopErr: any = null;
  try {
    await claimPairSession({ userId: "uA", pairCode: startedB.pairCode, companionBaseUrl: "http://attacker.example.com" });
  } catch (e: any) { nonLoopErr = e; }
  pass("non-loopback companion URL refused",
    nonLoopErr instanceof PairingError && nonLoopErr.code === "non_loopback_companion_url");

  let badProtoErr: any = null;
  try {
    validateCompanionBaseUrl("ftp://localhost:8390");
  } catch (e: any) { badProtoErr = e; }
  pass("non-http(s) companion URL refused",
    badProtoErr instanceof PairingError && badProtoErr.code === "bad_companion_url");

  let credsErr: any = null;
  try {
    validateCompanionBaseUrl("http://user:pass@127.0.0.1:8390");
  } catch (e: any) { credsErr = e; }
  pass("companion URL with embedded credentials refused",
    credsErr instanceof PairingError);

  // ─── status: claimed + online ─────────────────────────────────────
  const view = await getPairStatus({ userId: "u1", sessionId: claim.sessionId });
  pass("status: claimed", view.status === "claimed");
  pass("status: online when fresh heartbeat", view.online === true);
  pass("status returns companion base URL",
    view.companionBaseUrl === "http://127.0.0.1:8390");
  pass("status surfaces companion info",
    view.companionInfo?.packageVersion === "0.1.0");

  // ─── status: foreign user gets 'not_found' ────────────────────────
  let foreignErr: any = null;
  try { await getPairStatus({ userId: "u-other", sessionId: claim.sessionId }); }
  catch (e: any) { foreignErr = e; }
  pass("status hides session existence from foreign user",
    foreignErr instanceof PairingError && foreignErr.code === "not_found");

  // ─── status: stale heartbeat → offline ────────────────────────────
  rows[claim.sessionId].lastHeartbeatAt = Date.now() - SESSION_ONLINE_GRACE_MS - 1000;
  const stale = await getPairStatus({ userId: "u1", sessionId: claim.sessionId });
  pass("status: offline when heartbeat stale",
    stale.online === false && stale.status === "claimed");

  // ─── heartbeat ────────────────────────────────────────────────────
  const hbOk = await heartbeatPairSession({
    sessionId: claim.sessionId, sessionSecret: claim.sessionSecret,
    companionInfo: { codexState: "ready" },
  });
  pass("heartbeat with correct secret succeeds",
    hbOk.ok === true && hbOk.expiresAt > 0);

  const hbBad = await heartbeatPairSession({
    sessionId: claim.sessionId, sessionSecret: "wrong-secret-not-the-real-one",
  });
  pass("heartbeat with wrong secret rejected",
    hbBad.ok === false && hbBad.reason === "bad_secret");

  // ─── authenticateCompanion ────────────────────────────────────────
  const auth = await authenticateCompanion({
    sessionId: claim.sessionId, sessionSecret: claim.sessionSecret,
  });
  pass("authenticateCompanion succeeds with correct secret",
    auth?.userId === "u1" && auth?.sessionId === claim.sessionId);

  const authBad = await authenticateCompanion({
    sessionId: claim.sessionId, sessionSecret: "wrong",
  });
  pass("authenticateCompanion fails with wrong secret",
    authBad === null);

  // ─── revoke ───────────────────────────────────────────────────────
  await revokePairSession({ userId: "u1", sessionId: claim.sessionId });
  pass("revoke flips status",
    rows[claim.sessionId]?.status === "revoked");
  const afterRevoke = await getPairStatus({ userId: "u1", sessionId: claim.sessionId });
  pass("status after revoke = revoked + offline",
    afterRevoke.status === "revoked" && afterRevoke.online === false);

  // Heartbeat after revoke fails.
  const hbAfterRevoke = await heartbeatPairSession({
    sessionId: claim.sessionId, sessionSecret: claim.sessionSecret,
  });
  pass("heartbeat after revoke fails",
    hbAfterRevoke.ok === false && hbAfterRevoke.reason === "revoked");

  // Foreign-user revoke is silent no-op.
  const startedC = await startPairSession({ userId: "uC" });
  await claimPairSession({ userId: "uC", pairCode: startedC.pairCode, companionBaseUrl: "http://127.0.0.1:8392" });
  await revokePairSession({ userId: "u-other", sessionId: startedC.sessionId });
  pass("foreign-user revoke is a no-op (session still claimed)",
    rows[startedC.sessionId]?.status === "claimed");

  // ─── expiration ───────────────────────────────────────────────────
  const startedExp = await startPairSession({ userId: "uExp", now: Date.now() - PAIR_CODE_TTL_MS - 1000 });
  let expErr: any = null;
  try {
    await claimPairSession({ userId: "uExp", pairCode: startedExp.pairCode, companionBaseUrl: "http://127.0.0.1:8395" });
  } catch (e: any) { expErr = e; }
  pass("expired pair-code refused",
    expErr instanceof PairingError && expErr.code === "expired");
  pass("expired status persisted",
    rows[startedExp.sessionId]?.status === "expired");

  if (failed > 0) {
    console.error(`\n${failed} pair-store test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-pair-store tests passed");
})();
