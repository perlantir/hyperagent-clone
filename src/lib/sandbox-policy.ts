// P34 — Sandbox isolation policy.
//
// Sits in front of runPython / runShell to enforce three guardrails before
// the lambda hands work off to E2B:
//
//   1. **Concurrency cap** — per-user limit on simultaneously-active
//      sandboxes. Hard ceiling so one runaway agent can't fork-bomb the
//      account's e2b quota.
//
//   2. **Domain allowlist** — static URL extraction from the code/command
//      string. Network calls to non-allowlisted hosts are rejected before
//      execution. Imperfect (dynamic URLs slip through) but raises the bar
//      and makes intent visible in the audit log.
//
//   3. **Time-window throttle** — also caps total executions per minute
//      per user, so an infinite tool loop can't burn through quota.
//
// Each policy decision writes to sandbox_runs (so Command Center + /audit
// can show what's running) and emits an audit_log row on rejection.
//
// The module is split off from sandbox.ts to keep policy decisions
// testable without spinning up real e2b calls.

import crypto from "node:crypto";
import { pool } from "./db";
import { audit } from "./audit";
import { getPrefs } from "./preferences";

// ============ DEFAULT POLICY ============

// Sensible defaults — covers what agents legitimately need (LLM APIs, code
// hosting, package mirrors, Wikipedia, etc.) without opening the door to
// arbitrary egress. Users can edit via Settings.
export const DEFAULT_DOMAIN_ALLOWLIST = [
  // LLM providers — the agent often calls these from inside sandboxed code.
  "api.openai.com", "api.anthropic.com", "api.x.ai",
  "generativelanguage.googleapis.com",
  // Search & browsing
  "api.exa.ai", "api.tavily.com",
  // Package managers
  "pypi.org", "files.pythonhosted.org",
  "registry.npmjs.org",
  // Code hosting & docs
  "github.com", "raw.githubusercontent.com", "api.github.com",
  "gitlab.com", "bitbucket.org",
  // Reference data
  "en.wikipedia.org", "wikipedia.org",
  // Common open APIs the agent reaches for
  "httpbin.org", "jsonplaceholder.typicode.com",
];

export const DEFAULT_CONCURRENCY_CAP = 3;
export const DEFAULT_PER_MINUTE_CAP = 30;

export interface SandboxPolicy {
  domainAllowlist: string[];
  concurrencyCap: number;
  perMinuteCap: number;
  // When true, URL extraction failures default-allow rather than default-
  // deny. We default this to false (fail closed) so agents can't sneak
  // calls through obfuscated string concat.
  failOpen: boolean;
}

export async function getSandboxPolicy(userId: string): Promise<SandboxPolicy> {
  const prefs = await getPrefs(userId);
  const sb = prefs.sandboxPolicy || {};
  return {
    domainAllowlist: Array.isArray(sb.domainAllowlist) ? sb.domainAllowlist : DEFAULT_DOMAIN_ALLOWLIST,
    concurrencyCap: typeof sb.concurrencyCap === "number" && sb.concurrencyCap > 0 ? sb.concurrencyCap : DEFAULT_CONCURRENCY_CAP,
    perMinuteCap: typeof sb.perMinuteCap === "number" && sb.perMinuteCap > 0 ? sb.perMinuteCap : DEFAULT_PER_MINUTE_CAP,
    failOpen: !!sb.failOpen,
  };
}

export async function setSandboxPolicy(userId: string, patch: Partial<SandboxPolicy>): Promise<void> {
  const cur = await getSandboxPolicy(userId);
  const next: SandboxPolicy = { ...cur, ...patch };
  await pool().query(
    `UPDATE users SET preferences = preferences || $1::jsonb WHERE id=$2`,
    [JSON.stringify({ sandboxPolicy: next }), userId],
  );
}

// ============ URL EXTRACTION ============

// Extract every URL-looking host from a chunk of code or shell text.
// We pattern-match liberally so Python f-strings, bash heredocs, and
// JS template literals all surface. Returns the deduplicated host list.
//
// Recognized shapes:
//   - https://host/...  http://host/...  ws://host/...
//   - "https://host/..." with leading quote  → host
//   - urlopen("host"), requests.get("host")  → bare host arg
//   - curl https://host  /  curl 'host'      → host
//
// Output is the SET of distinct hostnames (lowercased, port stripped).
export function extractHosts(input: string): string[] {
  if (!input) return [];
  const hosts = new Set<string>();

  // 1. Full http(s)/ws(s) URLs.
  // Note: the IP shape inside this URL pattern is intentionally permissive
  // — we filter out loopback / 0.0.0.0 below so they don't count as
  // "network egress" for policy purposes.
  const urlRe = /\b(?:https?|wss?):\/\/([a-zA-Z0-9.-]+(?:\.[a-zA-Z]{2,})|localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(input))) {
    const h = m[1].toLowerCase();
    if (h === "127.0.0.1" || h === "0.0.0.0") continue;
    hosts.add(h);
  }

  // 2. Bare-quoted hostnames in HTTP-client calls — covers requests.get("host"),
  //    urllib.request.urlopen('host'), httpx.get(`host`), fetch("host").
  //    We accept either a full URL (handled above) or a bare TLD-shaped
  //    host. We DON'T match IPs here — they're handled in step 3.
  const httpClientRe = /\b(?:requests\.(?:get|post|put|patch|delete|head|options|request)|urlopen|fetch|httpx\.(?:get|post|put|patch|delete)|axios\.(?:get|post|put|patch|delete))\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  while ((m = httpClientRe.exec(input))) {
    const ref = m[1];
    const u = parseHost(ref);
    if (u) hosts.add(u);
  }

  // 3. curl/wget commands: pull the first non-flag token after the cmd.
  const curlRe = /\b(?:curl|wget|http)\b((?:\s+(?:-{1,2}[^\s]+|[^\s]+))+)/gi;
  while ((m = curlRe.exec(input))) {
    const args = m[1].split(/\s+/).filter(Boolean);
    for (const a of args) {
      if (a.startsWith("-")) continue;
      const cleaned = a.replace(/^['"`]|['"`]$/g, "");
      const h = parseHost(cleaned);
      if (h) { hosts.add(h); break; }   // first positional = URL/host
    }
  }

  // 4. Bare IPs (any kind of network identifier should surface).
  const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  while ((m = ipRe.exec(input))) {
    if (m[0] !== "0.0.0.0" && m[0] !== "127.0.0.1") hosts.add(m[0]);
  }

  return Array.from(hosts);
}

// Parse a hostname out of a string that may be a URL, "host:port",
// or "host/path". Returns lowercase host or null if the input doesn't
// look like a remote network reference.
//
// Loopback (127.0.0.1, 0.0.0.0) and IPv4 broadcast aren't egress, so
// they're filtered here as well as at the URL-regex layer.
function parseHost(s: string): string | null {
  if (!s) return null;
  s = s.trim().replace(/^['"`]|['"`]$/g, "");
  if (!s) return null;
  // Strip scheme.
  let rest = s.replace(/^(?:https?|wss?|ftp):\/\//i, "");
  // Strip path / query / fragment.
  rest = rest.split(/[\/?#]/)[0];
  // Strip credentials user:pass@
  rest = rest.split("@").pop() || rest;
  // Strip port.
  rest = rest.split(":")[0];
  if (!rest) return null;
  const lower = rest.toLowerCase();
  // Loopback shouldn't surface as a network host.
  if (lower === "127.0.0.1" || lower === "0.0.0.0") return null;
  // Heuristic: must contain a dot OR be 'localhost'.
  if (lower === "localhost") return lower;
  if (!lower.includes(".")) return null;
  if (!/^[a-zA-Z0-9.-]+$/.test(lower)) return null;
  return lower;
}

// ============ ALLOWLIST CHECK ============

// True iff `host` matches one of the allowlist entries.
//
// Matching rules:
//   - Bare entry "example.com" matches the apex AND all subdomains.
//   - Wildcard "*.example.com" matches subdomains ONLY (not the apex).
//     This follows the dnsmasq / RFC-6125 convention and forces operators
//     to explicitly allow the apex when they want it.
export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    const entry = raw.toLowerCase();
    if (entry.startsWith("*.")) {
      const sub = entry.slice(2);
      // Wildcard: subdomain-only match, apex deliberately excluded.
      if (h.endsWith("." + sub)) return true;
    } else {
      if (h === entry) return true;
      if (h.endsWith("." + entry)) return true;
    }
  }
  return false;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  blockedHosts?: string[];
  detectedHosts?: string[];
  concurrencyInUse?: number;
  perMinuteUsed?: number;
}

// Run all checks: concurrency cap, per-minute cap, domain allowlist.
// Pure-ish — does its own DB reads but no writes; the caller starts the
// sandbox-run record AFTER getting an `allowed: true` back.
export async function evaluatePolicy(
  userId: string,
  code: string,
  policy: SandboxPolicy,
): Promise<PolicyDecision> {
  await ensureSandboxRunsTable();

  // 1. Concurrency cap.
  const inflight = await pool().query(
    `SELECT COUNT(*)::int AS c FROM sandbox_runs WHERE "userId"=$1 AND "endedAt" IS NULL`,
    [userId],
  );
  const concurrencyInUse = Number(inflight.rows[0]?.c || 0);
  if (concurrencyInUse >= policy.concurrencyCap) {
    return {
      allowed: false,
      reason: `concurrency cap reached (${concurrencyInUse}/${policy.concurrencyCap} active sandboxes)`,
      concurrencyInUse,
    };
  }

  // 2. Per-minute throttle.
  const since = Date.now() - 60_000;
  const recent = await pool().query(
    `SELECT COUNT(*)::int AS c FROM sandbox_runs WHERE "userId"=$1 AND "startedAt" >= $2`,
    [userId, since],
  );
  const perMinuteUsed = Number(recent.rows[0]?.c || 0);
  if (perMinuteUsed >= policy.perMinuteCap) {
    return {
      allowed: false,
      reason: `per-minute cap reached (${perMinuteUsed}/${policy.perMinuteCap} executions in last 60s)`,
      perMinuteUsed,
    };
  }

  // 3. Domain allowlist — static URL extraction.
  const detectedHosts = extractHosts(code);
  const blockedHosts = detectedHosts.filter(h => !hostAllowed(h, policy.domainAllowlist));
  if (blockedHosts.length > 0) {
    return {
      allowed: false,
      reason: `network call(s) to non-allowlisted host(s): ${blockedHosts.join(", ")}`,
      blockedHosts,
      detectedHosts,
      concurrencyInUse,
      perMinuteUsed,
    };
  }

  return { allowed: true, detectedHosts, concurrencyInUse, perMinuteUsed };
}

// ============ SANDBOX_RUNS TABLE ============

let _tableEnsured = false;

export async function ensureSandboxRunsTable(): Promise<void> {
  if (_tableEnsured) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS sandbox_runs (
      id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      "codePreview" TEXT,
      "detectedHosts" TEXT,
      "startedAt" BIGINT NOT NULL,
      "endedAt" BIGINT,
      "durationMs" INTEGER,
      "exitCode" INTEGER,
      blocked BOOLEAN NOT NULL DEFAULT false,
      "blockReason" TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sandbox_runs_user
      ON sandbox_runs("userId", "startedAt" DESC);
    CREATE INDEX IF NOT EXISTS idx_sandbox_runs_active
      ON sandbox_runs("userId") WHERE "endedAt" IS NULL;
  `);
  _tableEnsured = true;
}

export async function startSandboxRun(input: {
  userId: string;
  kind: "code_interpreter" | "run_shell";
  code: string;
  detectedHosts: string[];
}): Promise<string> {
  await ensureSandboxRunsTable();
  const id = "sbr_" + crypto.randomBytes(8).toString("hex");
  await pool().query(
    `INSERT INTO sandbox_runs (id, "userId", kind, "codePreview", "detectedHosts", "startedAt")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id, input.userId, input.kind,
      input.code.slice(0, 4000),
      JSON.stringify(input.detectedHosts || []),
      Date.now(),
    ],
  );
  return id;
}

export async function endSandboxRun(
  id: string,
  result: { durationMs: number; exitCode: number },
): Promise<void> {
  await pool().query(
    `UPDATE sandbox_runs
     SET "endedAt" = $2, "durationMs" = $3, "exitCode" = $4
     WHERE id = $1`,
    [id, Date.now(), result.durationMs, result.exitCode],
  );
}

export async function recordBlockedRun(input: {
  userId: string;
  kind: "code_interpreter" | "run_shell";
  code: string;
  detectedHosts: string[];
  reason: string;
}): Promise<string> {
  await ensureSandboxRunsTable();
  const id = "sbr_" + crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  await pool().query(
    `INSERT INTO sandbox_runs (id, "userId", kind, "codePreview", "detectedHosts", "startedAt", "endedAt", "durationMs", blocked, "blockReason")
     VALUES ($1, $2, $3, $4, $5, $6, $6, 0, true, $7)`,
    [id, input.userId, input.kind, input.code.slice(0, 4000),
     JSON.stringify(input.detectedHosts || []), now, input.reason],
  );
  return id;
}

// Operator-facing list. Used by Command Center to surface in-flight + recent
// sandbox executions.
export interface SandboxRunRow {
  id: string;
  userId: string;
  kind: string;
  codePreview: string | null;
  detectedHosts: string[];
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  blocked: boolean;
  blockReason: string | null;
}

export async function listRecentSandboxRuns(userId: string, limit = 50): Promise<SandboxRunRow[]> {
  await ensureSandboxRunsTable();
  const r = await pool().query(
    `SELECT * FROM sandbox_runs WHERE "userId"=$1 ORDER BY "startedAt" DESC LIMIT $2`,
    [userId, limit],
  );
  return r.rows.map((row: any) => ({
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    codePreview: row.codePreview,
    detectedHosts: row.detectedHosts ? JSON.parse(row.detectedHosts) : [],
    startedAt: Number(row.startedAt),
    endedAt: row.endedAt ? Number(row.endedAt) : null,
    durationMs: row.durationMs,
    exitCode: row.exitCode,
    blocked: row.blocked,
    blockReason: row.blockReason,
  }));
}

// Used by /api/runs/[id]/cancel → not currently sandbox-aware, but
// exposed here in case we later let operators cancel an in-flight sandbox
// row (the e2b sandbox itself is stateless from our side).
export async function markSandboxRunOrphaned(id: string): Promise<void> {
  await pool().query(
    `UPDATE sandbox_runs SET "endedAt"=$2, "exitCode"=-1 WHERE id=$1 AND "endedAt" IS NULL`,
    [id, Date.now()],
  );
}

// Audit-log helper, kept here so the chat route doesn't need to know audit
// internals when it dispatches a sandbox call.
export async function auditSandboxBlocked(input: {
  userId: string;
  kind: string;
  reason: string;
  blockedHosts?: string[];
  detectedHosts?: string[];
}): Promise<void> {
  await audit({
    userId: input.userId,
    action: "sandbox.blocked",
    resource: input.kind,
    result: "denied",
    metadata: {
      reason: input.reason,
      blockedHosts: input.blockedHosts || [],
      detectedHosts: input.detectedHosts || [],
    },
  });
}

export async function auditSandboxExec(input: {
  userId: string;
  kind: string;
  durationMs: number;
  exitCode: number;
  detectedHosts: string[];
}): Promise<void> {
  await audit({
    userId: input.userId,
    action: "sandbox.exec",
    resource: input.kind,
    result: input.exitCode === 0 ? "success" : "failure",
    metadata: {
      durationMs: input.durationMs,
      exitCode: input.exitCode,
      detectedHosts: input.detectedHosts,
    },
  });
}
