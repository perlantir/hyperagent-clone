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

import { resolveSecret } from "./secrets";

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
  const sandbox = await createSandbox(userId, "code-interpreter-v1");
  try {
    const k = await key(userId);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let stdout = "";
    let stderr = "";
    let result: any = undefined;
    let exitCode = 0;

    try {
      // e2b's run-code endpoint streams output as NDJSON events.
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
        return {
          stdout: "", stderr: `e2b run-code ${r.status}: ${text.slice(0, 400)}`,
          exitCode: 1, durationMs: Date.now() - start,
        };
      }

      // Parse NDJSON streaming response
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
          // Not JSON — append as plaintext stdout
          stdout += line + "\n";
        }
      }
    } finally {
      clearTimeout(timer);
    }

    return {
      stdout: stdout.slice(0, 16_000),
      stderr: stderr.slice(0, 8_000),
      exitCode,
      result: result !== undefined ? result : undefined,
      durationMs: Date.now() - start,
    };
  } finally {
    // Always cleanup
    await killSandbox(userId, sandbox.sandboxId);
  }
}

// Run a shell command in a fresh base sandbox.
export async function runShell(
  command: string,
  opts: { userId?: string | null; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const userId = opts.userId || null;
  const timeoutMs = opts.timeoutMs || 60_000;
  const start = Date.now();
  const sandbox = await createSandbox(userId, "base");
  try {
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
      let stdout = "", stderr = "", exitCode = r.ok ? 0 : 1;
      try {
        const j = JSON.parse(text);
        stdout = j.stdout || "";
        stderr = j.stderr || "";
        exitCode = j.exitCode ?? exitCode;
      } catch {
        stdout = text;
      }
      return {
        stdout: stdout.slice(0, 16_000),
        stderr: stderr.slice(0, 8_000),
        exitCode,
        durationMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await killSandbox(userId, sandbox.sandboxId);
  }
}
