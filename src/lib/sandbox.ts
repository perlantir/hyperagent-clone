// Sandboxed code execution via e2b.dev.
//
// Each call spins up an ephemeral micro-VM (Firecracker), runs the requested
// code, returns stdout/stderr/result, and tears down. For agents that need
// to actually compute (data analysis, file processing, API call composition,
// etc.) rather than just describe what they would compute.
//
// Uses raw HTTPS to the e2b REST API. Per-user keys via resolveSecret;
// platform fallback to E2B_API_KEY env var.
//
// API key resolution: user's saved key → E2B_API_KEY → throws.
//
// P34 — every call is gated by sandbox-policy.ts: domain allowlist,
// per-user concurrency cap, per-minute throttle. Decisions are audited
// (sandbox.exec / sandbox.blocked) and tracked in sandbox_runs so
// Command Center sees what's running.

import { resolveSecret } from "./secrets";
import {
  getSandboxPolicy, evaluatePolicy,
  startSandboxRun, endSandboxRun, recordBlockedRun,
  auditSandboxBlocked, auditSandboxExec,
} from "./sandbox-policy";

const E2B_BASE = "https://api.e2b.dev";

async function key(userId: string | null | undefined): Promise<string> {
  const k = await resolveSecret(userId, "e2b");
  if (!k) throw new Error("e2b API key not configured. Add one in Settings → API Keys.");
  return k;
}

interface SandboxHandle {
  sandboxId: string;
  templateId: string;
}

// Create a fresh sandbox. Templates: 'base' (Ubuntu + Python), 'code-interpreter-v1'
// (Jupyter-like Python with pandas/numpy preinstalled). Default is 'code-interpreter-v1'.
async function createSandbox(userId: string | null, template = "code-interpreter-v1"): Promise<SandboxHandle> {
  const k = await key(userId);
  const r = await fetch(`${E2B_BASE}/sandboxes`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${k}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ templateID: template, metadata: { source: "hyperagent" } }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`e2b createSandbox ${r.status}: ${text.slice(0, 400)}`);
  }
  const j = await r.json();
  return { sandboxId: j.sandboxID || j.sandboxId, templateId: j.templateID || template };
}

async function killSandbox(userId: string | null, sandboxId: string): Promise<void> {
  const k = await key(userId);
  try {
    await fetch(`${E2B_BASE}/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${k}` },
    });
  } catch {}
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  result?: any;        // For code_interpreter: the last expression value
  durationMs: number;
}

// Run Python code in a fresh sandbox. The sandbox is created, the code is
// executed via the Jupyter kernel running in the template, results collected,
// then the sandbox is torn down.
//
// e2b's REST API for code-interpreter exposes a /run-code endpoint that
// accepts code and returns structured output. We wrap it with a single-shot
// lifecycle here (create → run → destroy).
export async function runPython(
  code: string,
  opts: { userId?: string | null; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const userId = opts.userId || null;
  const timeoutMs = opts.timeoutMs || 60_000;
  const start = Date.now();

  // P34 — policy gate. Only enforce for authenticated calls; anonymous
  // platform-internal callers (server-side cron sweeps, etc.) bypass.
  let sbRunId: string | null = null;
  let detectedHosts: string[] = [];
  if (userId) {
    const policy = await getSandboxPolicy(userId);
    const decision = await evaluatePolicy(userId, code, policy);
    detectedHosts = decision.detectedHosts || [];
    if (!decision.allowed) {
      await recordBlockedRun({
        userId, kind: "code_interpreter", code, detectedHosts,
        reason: decision.reason || "policy violation",
      });
      await auditSandboxBlocked({
        userId, kind: "code_interpreter",
        reason: decision.reason || "policy violation",
        blockedHosts: decision.blockedHosts,
        detectedHosts,
      });
      return {
        stdout: "",
        stderr: `[sandbox blocked] ${decision.reason}\n\nEdit the policy in Settings → Sandbox to allow this domain or raise the cap.`,
        exitCode: 1,
        durationMs: Date.now() - start,
      };
    }
    sbRunId = await startSandboxRun({
      userId, kind: "code_interpreter", code, detectedHosts,
    });
  }

  let stdout = "";
  let stderr = "";
  let result: any = undefined;
  let exitCode = 0;

  let sandbox: SandboxHandle | null = null;
  try {
    sandbox = await createSandbox(userId, "code-interpreter-v1");
    const k = await key(userId);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const r = await fetch(`${E2B_BASE}/sandboxes/${sandbox.sandboxId}/run-code`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Authorization": `Bearer ${k}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code, language: "python" }),
      });

      if (!r.ok) {
        const text = await r.text();
        stderr = `e2b run-code ${r.status}: ${text.slice(0, 400)}`;
        exitCode = 1;
      } else {
        const text = await r.text();
        const lines = text.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === "stdout" || ev.stdout) stdout += ev.text || ev.stdout || "";
            else if (ev.type === "stderr" || ev.stderr) stderr += ev.text || ev.stderr || "";
            else if (ev.type === "result" || ev.result) result = ev.result ?? ev.value ?? ev;
            else if (ev.type === "error") { stderr += (ev.message || "") + "\n"; exitCode = 1; }
          } catch {
            stdout += line + "\n";
          }
        }
      }
    } catch (e: any) {
      stderr += `\n[sandbox error] ${e.message || e}`;
      exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (sandbox) await killSandbox(userId, sandbox.sandboxId);

    // P34 — record outcome regardless of how the function exits.
    if (sbRunId && userId) {
      const durationMs = Date.now() - start;
      try { await endSandboxRun(sbRunId, { durationMs, exitCode }); }
      catch (e) { console.error("[sandbox endRun]", e); }
      try { await auditSandboxExec({ userId, kind: "code_interpreter", durationMs, exitCode, detectedHosts }); }
      catch (e) { console.error("[sandbox audit]", e); }
    }
  }

  return {
    stdout: stdout.slice(0, 16_000),
    stderr: stderr.slice(0, 8_000),
    exitCode,
    result: result !== undefined ? result : undefined,
    durationMs: Date.now() - start,
  };
}

// Run a shell command in a fresh base sandbox.
export async function runShell(
  command: string,
  opts: { userId?: string | null; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const userId = opts.userId || null;
  const timeoutMs = opts.timeoutMs || 60_000;
  const start = Date.now();

  // P34 — same policy gate as runPython.
  let sbRunId: string | null = null;
  let detectedHosts: string[] = [];
  if (userId) {
    const policy = await getSandboxPolicy(userId);
    const decision = await evaluatePolicy(userId, command, policy);
    detectedHosts = decision.detectedHosts || [];
    if (!decision.allowed) {
      await recordBlockedRun({
        userId, kind: "run_shell", code: command, detectedHosts,
        reason: decision.reason || "policy violation",
      });
      await auditSandboxBlocked({
        userId, kind: "run_shell",
        reason: decision.reason || "policy violation",
        blockedHosts: decision.blockedHosts,
        detectedHosts,
      });
      return {
        stdout: "",
        stderr: `[sandbox blocked] ${decision.reason}\n\nEdit the policy in Settings → Sandbox to allow this domain or raise the cap.`,
        exitCode: 1,
        durationMs: Date.now() - start,
      };
    }
    sbRunId = await startSandboxRun({
      userId, kind: "run_shell", code: command, detectedHosts,
    });
  }

  let stdout = "", stderr = "", exitCode = 0;
  let sandbox: SandboxHandle | null = null;
  try {
    sandbox = await createSandbox(userId, "base");
    const k = await key(userId);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${E2B_BASE}/sandboxes/${sandbox.sandboxId}/process`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Authorization": `Bearer ${k}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ cmd: command }),
      });
      const text = await r.text();
      exitCode = r.ok ? 0 : 1;
      try {
        const j = JSON.parse(text);
        stdout = j.stdout || "";
        stderr = j.stderr || "";
        exitCode = j.exitCode ?? exitCode;
      } catch {
        stdout = text;
      }
    } catch (e: any) {
      stderr += `\n[sandbox error] ${e.message || e}`;
      exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (sandbox) await killSandbox(userId, sandbox.sandboxId);
    if (sbRunId && userId) {
      const durationMs = Date.now() - start;
      try { await endSandboxRun(sbRunId, { durationMs, exitCode }); }
      catch (e) { console.error("[sandbox endRun]", e); }
      try { await auditSandboxExec({ userId, kind: "run_shell", durationMs, exitCode, detectedHosts }); }
      catch (e) { console.error("[sandbox audit]", e); }
    }
  }

  return {
    stdout: stdout.slice(0, 16_000),
    stderr: stderr.slice(0, 8_000),
    exitCode,
    durationMs: Date.now() - start,
  };
}
