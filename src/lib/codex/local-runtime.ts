// P64 — Phase 2 runtime detection.
//
// Reports whether the current Node process can spawn `codex app-server`
// as a child process. Used by the Settings UI to decide if the
// "Automatic local connection" mode is even offered, and by the chat
// dispatcher to decide which transport to use.
//
// On Vercel and other serverless platforms, `child_process.spawn` is
// either disabled or pointless (the process disappears between requests).
// We detect a serverless runtime up front and refuse to even try.

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { delimiter, sep } from "node:path";

// Hard ceilings for the binary-detection cache so a missing-then-installed
// codex doesn't stay missing forever in long-lived processes.
const BINARY_CACHE_TTL_MS = 30_000;
let _binaryCache: { ts: number; binary: string | null } | null = null;

export interface LocalRuntimeStatus {
  // True only when this Node process can realistically host a long-lived
  // child process. False on Vercel / Lambda / Cloudflare Workers.
  supportsSpawn: boolean;
  // Reason supportsSpawn is false. UI uses this to explain to the user
  // why Phase 2 isn't available and to show the right alternative
  // (Phase 1 paste or Phase 3 companion).
  reason?: "vercel-hosted" | "explicitly-disabled" | "unknown-serverless";
  // Path to the `codex` binary if found on PATH; null if missing.
  // Only populated when supportsSpawn is true.
  codexBinary: string | null;
  // Build / runtime hints we surface in the UI for clarity.
  runtime: "vercel" | "node-server" | "unknown";
}

/**
 * Synchronous best-effort check. Suitable to call on every request.
 */
export function getLocalRuntimeStatus(): LocalRuntimeStatus {
  // Vercel sets VERCEL=1 + VERCEL_ENV. Even if child_process technically
  // exists in their Node runtime, lambdas are stateless — a spawned
  // codex would die between requests.
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    return {
      supportsSpawn: false,
      reason: "vercel-hosted",
      codexBinary: null,
      runtime: "vercel",
    };
  }

  // Allow ops to explicitly disable Phase 2 even when running on a Node
  // server (e.g. shared multi-tenant host where users shouldn't be able
  // to spawn binaries from other tenants' contexts).
  if (process.env.HYPERAGENT_DISABLE_LOCAL_CODEX === "1") {
    return {
      supportsSpawn: false,
      reason: "explicitly-disabled",
      codexBinary: null,
      runtime: "node-server",
    };
  }

  // Cloudflare Workers / edge runtimes don't expose `child_process`.
  // Detect via the absence of process.versions.node (very old Node) OR
  // edge runtime feature flag.
  if (typeof process === "undefined" || !process.versions?.node) {
    return {
      supportsSpawn: false,
      reason: "unknown-serverless",
      codexBinary: null,
      runtime: "unknown",
    };
  }

  return {
    supportsSpawn: true,
    codexBinary: detectCodexBinary(),
    runtime: "node-server",
  };
}

/**
 * Locate the `codex` binary on the user's PATH. Returns the absolute
 * path or null.
 *
 * We avoid running the binary itself for a version check — that costs
 * latency on every request. We just verify the file exists. The chat
 * dispatcher will surface a clearer error if the binary is broken.
 */
export function detectCodexBinary(): string | null {
  if (_binaryCache && Date.now() - _binaryCache.ts < BINARY_CACHE_TTL_MS) {
    return _binaryCache.binary;
  }
  let binary: string | null = null;
  try {
    // 1. Honor an explicit CODEX_BIN override.
    if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) {
      binary = process.env.CODEX_BIN;
    } else {
      // 2. Walk PATH manually. Avoids needing `which` on Windows.
      const pathDirs = (process.env.PATH || "").split(delimiter);
      const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
      outer: for (const dir of pathDirs) {
        if (!dir) continue;
        for (const ext of exts) {
          const candidate = dir + sep + "codex" + ext;
          if (existsSync(candidate)) { binary = candidate; break outer; }
        }
      }
    }
  } catch {
    binary = null;
  }
  _binaryCache = { ts: Date.now(), binary };
  return binary;
}

/**
 * Force-refresh the binary detection cache. Tests and the settings
 * "I just installed codex" UX can call this.
 */
export function invalidateBinaryCache(): void {
  _binaryCache = null;
}

/**
 * Run `codex --version` and return the version string. Best-effort —
 * returns null if the binary is missing or unresponsive. Never throws.
 */
export function getCodexVersion(): string | null {
  const bin = detectCodexBinary();
  if (!bin) return null;
  try {
    const out = execSync(`${bin} --version`, { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return out.toString().trim().slice(0, 80);
  } catch {
    return null;
  }
}
