// P64.2 — WS message framing test.
//
// The handshake test showed: codex accepts an Authorization: Bearer header,
// but our subsequent `initialize` request never gets a response. Stdio
// works fine with newline-delimited framing. This test asks: does codex
// over WS expect MESSAGE-per-frame (one WS frame = one JSON envelope) or
// NEWLINE-delimited (frames may concatenate, frames may split)?

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";

if (process.env.CODEX_SMOKE_TEST !== "1") {
  console.error("Refusing to run without CODEX_SMOKE_TEST=1");
  process.exit(2);
}

const CODEX_BIN = process.env.CODEX_BIN || "codex";

async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        s.close(() => resolve(port));
      } else reject(new Error("no port"));
    });
    s.on("error", reject);
  });
}

async function tryFraming(opts: {
  scenario: string;
  args: string[];
  authHeader?: string;
  framingMode: "with-newline" | "no-newline";
}) {
  const port = await pickPort();
  const args = opts.args.map((a) => a.replace("$PORT", String(port)));
  const child = spawn(CODEX_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderrAccum = "";
  child.stderr!.setEncoding("utf-8");
  child.stderr!.on("data", (d) => (stderrAccum += d.toString()));
  await delay(700);

  const { default: WebSocketImpl } = await import("ws");
  const ws = new WebSocketImpl(
    `ws://127.0.0.1:${port}`,
    undefined,
    opts.authHeader ? { headers: { Authorization: opts.authHeader } } : undefined,
  );
  const result: any = { scenario: opts.scenario, framingMode: opts.framingMode };

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
      resolve();
    };
    const timeout = setTimeout(() => {
      result.timedOut = true;
      finish();
    }, 4000);

    ws.on("open", () => {
      result.connected = true;
      const frame = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "ws-framing-smoke",
            title: null,
            version: "0.0.0",
          },
          capabilities: { experimentalApi: false, optOutNotificationMethods: null },
        },
      });
      ws.send(opts.framingMode === "with-newline" ? frame + "\n" : frame);
    });
    ws.on("message", (data: Buffer | string) => {
      const s = typeof data === "string" ? data : data.toString();
      result.firstResponse = s.slice(0, 600);
      try {
        const parsed = JSON.parse(s.trim());
        result.parsed = true;
        if (parsed.id === 1 && parsed.result) result.initializeOk = true;
        if (parsed.id === 1 && parsed.error) {
          result.initializeOk = false;
          result.initializeError = parsed.error;
        }
      } catch (e: any) {
        result.parsed = false;
        result.parseError = e.message;
      }
      clearTimeout(timeout);
      finish();
    });
    ws.on("error", (e: any) => {
      result.error = e.message;
    });
    ws.on("unexpected-response", (_req: any, res: any) => {
      result.error = `HTTP ${res.statusCode}`;
      clearTimeout(timeout);
      finish();
    });
    ws.on("close", () => {
      // If we got here without a message, finish.
      if (!result.firstResponse) {
        clearTimeout(timeout);
        finish();
      }
    });
  });

  result.serverStderr = stderrAccum.slice(0, 400);
  return result;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "codex-ws-framing-"));
  const token = randomBytes(32).toString("hex");
  writeFileSync(join(tmp, "token"), token, { mode: 0o600 });
  const sha = createHash("sha256").update(token).digest("hex");

  const out: any[] = [];

  // 1. Loopback, no auth flags, framing WITH newline.
  out.push(
    await tryFraming({
      scenario: "loopback-no-auth-newline",
      args: ["app-server", "--listen", "ws://127.0.0.1:$PORT"],
      framingMode: "with-newline",
    }),
  );

  // 2. Loopback, no auth flags, framing WITHOUT newline (message-per-frame).
  out.push(
    await tryFraming({
      scenario: "loopback-no-auth-no-newline",
      args: ["app-server", "--listen", "ws://127.0.0.1:$PORT"],
      framingMode: "no-newline",
    }),
  );

  // 3. Loopback, --ws-auth capability-token, Authorization Bearer, WITH newline.
  out.push(
    await tryFraming({
      scenario: "loopback-auth-bearer-newline",
      args: [
        "app-server",
        "--listen",
        "ws://127.0.0.1:$PORT",
        "--ws-auth",
        "capability-token",
        "--ws-token-sha256",
        sha,
      ],
      authHeader: `Bearer ${token}`,
      framingMode: "with-newline",
    }),
  );

  // 4. Loopback, --ws-auth capability-token, Authorization Bearer, NO newline.
  out.push(
    await tryFraming({
      scenario: "loopback-auth-bearer-no-newline",
      args: [
        "app-server",
        "--listen",
        "ws://127.0.0.1:$PORT",
        "--ws-auth",
        "capability-token",
        "--ws-token-sha256",
        sha,
      ],
      authHeader: `Bearer ${token}`,
      framingMode: "no-newline",
    }),
  );

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
