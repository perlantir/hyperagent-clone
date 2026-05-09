// codex-process.js — spawn + supervise the codex app-server binary.
//
// We prefer stdio transport because:
//   - it's the simplest secure path (parent process owns the child)
//   - no auth handshake to manage
//   - no listener flags / firewall concerns
//
// The companion exposes only its own browser-facing HTTP/WS server.
// Codex never speaks directly to the browser.

const { spawn, spawnSync } = require("node:child_process");

function detectCodex(binPath) {
  // Cheap PATH check.
  const r = spawnSync(binPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) {
    return { found: false, error: r.error.code === "ENOENT"
      ? `Codex binary not found at "${binPath}". Install it from https://github.com/openai/codex.`
      : `Failed to run codex: ${r.error.message}` };
  }
  const versionLine = (r.stdout?.toString("utf8") || "").trim();
  return { found: true, version: versionLine };
}

class CodexProcess {
  constructor({ binPath, codexHome, codexEnvOverrides }) {
    this.binPath = binPath || "codex";
    this.codexHome = codexHome || process.env.CODEX_HOME || null;
    this.codexEnvOverrides = codexEnvOverrides || {};
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.serverRequestHandlers = new Set();
    this.errorHandlers = new Set();
    this.exitHandlers = new Set();
    this.stderrHandlers = new Set();
    this._closed = false;
  }

  start() {
    if (this.child) throw new Error("CodexProcess already started");
    const env = { ...process.env, ...this.codexEnvOverrides };
    if (this.codexHome) env.CODEX_HOME = this.codexHome;
    this.child = spawn(this.binPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      // Cap line length so a runaway log can't blow up our buffer.
      const lines = chunk.split("\n").map((s) => s.trim()).filter(Boolean);
      for (const ln of lines) {
        const trimmed = ln.length > 1000 ? ln.slice(0, 1000) + " …(truncated)" : ln;
        for (const h of this.stderrHandlers) {
          try { h(trimmed); } catch {}
        }
      }
    });
    this.child.on("error", (e) => {
      for (const h of this.errorHandlers) try { h(e); } catch {}
    });
    this.child.on("close", (code) => {
      this._closed = true;
      // Reject every pending request so callers don't hang.
      for (const p of this.pending.values()) {
        p.reject(new Error("codex app-server exited"));
      }
      this.pending.clear();
      for (const h of this.exitHandlers) try { h(code); } catch {}
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, 600);
      this.child.once("spawn", () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve();
      });
      this.child.once("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        reject(e);
      });
    });
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let env;
      try { env = JSON.parse(line); }
      catch { continue; }
      this._dispatchEnvelope(env);
    }
  }

  _dispatchEnvelope(env) {
    if (!env || typeof env !== "object") return;
    if (env.id !== undefined && (env.result !== undefined || env.error !== undefined)) {
      const p = this.pending.get(env.id);
      if (p) {
        this.pending.delete(env.id);
        if (env.error) p.reject(Object.assign(new Error(env.error.message || "codex error"), {
          codexCode: env.error.code,
          codexData: env.error.data,
        }));
        else p.resolve(env.result);
      }
      return;
    }
    if (env.id !== undefined && typeof env.method === "string") {
      // Server-initiated request; fan out to handlers. Each handler
      // may return a result (or throw an error) and we'll send the
      // first one that resolves. If none handles, reply -32601.
      for (const h of this.serverRequestHandlers) {
        try {
          const maybe = h(env);
          if (maybe && typeof maybe.then === "function") {
            maybe.then(
              (r) => this.respondToServerRequest(env.id, r),
              (e) => this.respondToServerRequest(env.id, undefined, {
                code: -32000,
                message: String(e && e.message ? e.message : e).slice(0, 500),
              }),
            );
            return;
          }
        } catch (e) {
          this.respondToServerRequest(env.id, undefined, {
            code: -32000,
            message: String(e && e.message ? e.message : e).slice(0, 500),
          });
          return;
        }
      }
      this.respondToServerRequest(env.id, undefined, {
        code: -32601,
        message: `No handler for ${env.method}`,
      });
      return;
    }
    if (typeof env.method === "string") {
      for (const h of this.notificationHandlers) {
        try { h(env); } catch {}
      }
    }
  }

  request(method, params, opts = {}) {
    if (this._closed) return Promise.reject(new Error("codex process is closed"));
    const id = this.nextId++;
    const env = { jsonrpc: "2.0", id, method };
    if (params !== undefined) env.params = params;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`codex ${method} timed out`));
        }
      }, opts.timeoutMs || 30_000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(t); resolve(r); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.child.stdin.write(JSON.stringify(env) + "\n");
    });
  }

  respondToServerRequest(id, result, error) {
    const env = { jsonrpc: "2.0", id };
    if (error) env.error = error;
    else env.result = result === undefined ? null : result;
    try {
      this.child.stdin.write(JSON.stringify(env) + "\n");
    } catch {}
  }

  notification(method, params) {
    if (this._closed) return;
    const env = { jsonrpc: "2.0", method };
    if (params !== undefined) env.params = params;
    try { this.child.stdin.write(JSON.stringify(env) + "\n"); } catch {}
  }

  onNotification(h) { this.notificationHandlers.add(h); return () => this.notificationHandlers.delete(h); }
  onServerRequest(h) { this.serverRequestHandlers.add(h); return () => this.serverRequestHandlers.delete(h); }
  onStderr(h) { this.stderrHandlers.add(h); return () => this.stderrHandlers.delete(h); }
  onError(h) { this.errorHandlers.add(h); return () => this.errorHandlers.delete(h); }
  onExit(h) { this.exitHandlers.add(h); return () => this.exitHandlers.delete(h); }

  async stop({ timeoutMs = 2000 } = {}) {
    if (!this.child || this._closed) return;
    try { this.child.stdin.end(); } catch {}
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { this.child.kill("SIGTERM"); } catch {}
        resolve();
      }, timeoutMs);
      this.child.once("close", () => { clearTimeout(t); resolve(); });
    });
  }
}

module.exports = { CodexProcess, detectCodex };
