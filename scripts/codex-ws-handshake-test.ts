// P64.2 — Test client-side WebSocket handshake against real codex.
//
// The first smoke test only confirmed the LISTENER startup contract.
// This test drives a real WS client through three handshake patterns to
// determine which (if any) the codex app-server actually accepts:
//
//   1. Loopback, NO auth flags on listener, NO token from client.
//      → Should succeed (loopback is unauthenticated by spec).
//   2. Loopback, --ws-auth capability-token on listener, NO token.
//      → Tells us whether auth is required for loopback.
//   3. Loopback, --ws-auth capability-token on listener, token via
//      Sec-WebSocket-Protocol subprotocol "codex-bridge.bearer.<TOKEN>".
//      → Confirms or refutes our subprotocol assumption.
//   4. Same as 3 but token via Authorization: Bearer <TOKEN> header.
//      → Tells us the alternative.
//
// Output: JSON to stdout reporting which patterns work.
//
// Run: CODEX_SMOKE_TEST=1 npx tsx scripts/codex-ws-handshake-test.ts

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

// Pick a free port by binding ephemeral and releasing.
async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
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

interface HandshakeResult {
  scenario: string;
  connected: boolean;
  initializeOk?: boolean;
  initializeError?: string;
  closeCode?: number;
  closeReason?: string;
  error?: string;
  serverStderr?: string;
}

async function startServer(args: string[]): Promise<{
  child: ReturnType<typeof spawn>;
  stderr: string;
  ready: Promise<void>;
}> {
  const child = spawn(CODEX_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderrAccum = "";
  child.stderr!.setEncoding("utf-8");
  child.stderr!.on("data", (d) => (stderrAccum += d.toString()));
  // Give the listener ~700ms to bind. We don't get a definitive "ready"
  // signal from the binary on stderr.
  const ready = delay(700).then(() => undefined);
  return {
    child,
    get stderr() {
      return stderrAccum;
    },
    ready,
  } as any;
}

async function tryHandshake(opts: {
  scenario: string;
  url: string;
  subprotocol?: string;
  authHeader?: string;
}): Promise<HandshakeResult> {
  const { default: WebSocketImpl } = await import("ws");
  return new Promise<HandshakeResult>((resolve) => {
    const result: HandshakeResult = { scenario: opts.scenario, connected: false };
    const headers: Record<string, string> = {};
    if (opts.authHeader) headers["Authorization"] = opts.authHeader;
    let ws: any;
    try {
      ws = new WebSocketImpl(opts.url, opts.subprotocol ? [opts.subprotocol] : undefined, {
        headers: Object.keys(headers).length ? headers : undefined,
      });
    } catch (e: any) {
      result.error = `construct: ${e.message}`;
      resolve(result);
      return;
    }

    let buffer = "";
    let nextId = 1;
    const pending = new Map<number, (e: any) => void>();
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      result.error = result.error || "timeout";
      resolve(result);
    }, 5000);

    ws.on("open", async () => {
      result.connected = true;
      // Try initialize.
      const id = nextId++;
      pending.set(id, (resp) => {
        clearTimeout(timeout);
        if (resp.error) {
          result.initializeOk = false;
          result.initializeError = JSON.stringify(resp.error);
        } else {
          result.initializeOk = true;
        }
        try {
          ws.close();
        } catch {}
        resolve(result);
      });
      try {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "initialize",
            params: {
              clientInfo: {
                name: "ws-handshake-smoke",
                title: null,
                version: "0.0.0",
              },
              capabilities: { experimentalApi: false, optOutNotificationMethods: null },
            },
          }) + "\n",
        );
      } catch (e: any) {
        clearTimeout(timeout);
        result.error = `send: ${e.message}`;
        resolve(result);
      }
    });
    ws.on("message", (data: Buffer | string) => {
      buffer += typeof data === "string" ? data : data.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const env = JSON.parse(line);
          if (env.id !== undefined && pending.has(env.id)) {
            pending.get(env.id)!(env);
          }
        } catch {}
      }
    });
    ws.on("close", (code: number, reason: Buffer) => {
      result.closeCode = code;
      result.closeReason = reason?.toString() || "";
      if (!result.connected) {
        clearTimeout(timeout);
        resolve(result);
      }
    });
    ws.on("error", (e: any) => {
      result.error = result.error || e.message;
      // Don't resolve — the close event will follow and produce the
      // canonical resolution.
    });
    ws.on("unexpected-response", (_req: any, res: any) => {
      result.error = `HTTP ${res.statusCode}`;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {}
      resolve(result);
    });
  });
}

async function withServer<T>(
  args: string[],
  fn: (port: number) => Promise<T>,
): Promise<{ result: T; serverStderr: string }> {
  const port = await pickPort();
  const portArgs = args.map((a) => a.replace("$PORT", String(port)));
  const { child, ready } = await startServer(portArgs);
  await ready;
  let stderrAccum = "";
  child.stderr!.on("data", (d: Buffer) => (stderrAccum += d.toString()));
  // Capture early stderr.
  await delay(100);
  try {
    const result = await fn(port);
    try {
      child.kill("SIGTERM");
    } catch {}
    await delay(200);
    return { result, serverStderr: stderrAccum };
  } catch (e) {
    try {
      child.kill("SIGKILL");
    } catch {}
    throw e;
  }
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "codex-ws-"));
  const token = randomBytes(32).toString("hex"); // 256-bit
  const tokenFile = join(tmp, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const sha = createHash("sha256").update(token).digest("hex");

  const out: { results: HandshakeResult[]; notes: string[] } = {
    results: [],
    notes: [],
  };

  // Scenario 1: loopback, NO --ws-auth, NO token from client.
  console.error("[ws] scenario 1: loopback, no auth flags, no token");
  const s1 = await withServer(["app-server", "--listen", "ws://127.0.0.1:$PORT"], async (port) => {
    return tryHandshake({ scenario: "loopback-no-auth", url: `ws://127.0.0.1:${port}` });
  });
  s1.result.serverStderr = s1.serverStderr.slice(0, 400);
  out.results.push(s1.result);

  // Scenario 2: loopback, --ws-auth capability-token, NO token from client.
  console.error("[ws] scenario 2: loopback, capability-token required, NO token");
  const s2 = await withServer(
    [
      "app-server",
      "--listen",
      "ws://127.0.0.1:$PORT",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      sha,
    ],
    async (port) => {
      return tryHandshake({ scenario: "loopback-auth-required-no-token", url: `ws://127.0.0.1:${port}` });
    },
  );
  s2.result.serverStderr = s2.serverStderr.slice(0, 400);
  out.results.push(s2.result);

  // Scenario 3: loopback, --ws-auth, token via Sec-WebSocket-Protocol.
  console.error("[ws] scenario 3: loopback, capability-token, subprotocol bearer");
  const s3 = await withServer(
    [
      "app-server",
      "--listen",
      "ws://127.0.0.1:$PORT",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      sha,
    ],
    async (port) => {
      return tryHandshake({
        scenario: "loopback-auth-subprotocol",
        url: `ws://127.0.0.1:${port}`,
        subprotocol: `codex-bridge.bearer.${token}`,
      });
    },
  );
  s3.result.serverStderr = s3.serverStderr.slice(0, 400);
  out.results.push(s3.result);

  // Scenario 4: loopback, --ws-auth, token via Authorization header.
  console.error("[ws] scenario 4: loopback, capability-token, Authorization header");
  const s4 = await withServer(
    [
      "app-server",
      "--listen",
      "ws://127.0.0.1:$PORT",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      sha,
    ],
    async (port) => {
      return tryHandshake({
        scenario: "loopback-auth-header",
        url: `ws://127.0.0.1:${port}`,
        authHeader: `Bearer ${token}`,
      });
    },
  );
  s4.result.serverStderr = s4.serverStderr.slice(0, 400);
  out.results.push(s4.result);

  // Scenario 5: loopback, --ws-auth, token via Sec-WebSocket-Protocol with
  // simpler "Bearer" prefix (RFC 6455 sub-protocol style).
  console.error("[ws] scenario 5: loopback, subprotocol 'Bearer.<TOKEN>'");
  const s5 = await withServer(
    [
      "app-server",
      "--listen",
      "ws://127.0.0.1:$PORT",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      sha,
    ],
    async (port) => {
      return tryHandshake({
        scenario: "loopback-auth-bearer-prefix",
        url: `ws://127.0.0.1:${port}`,
        subprotocol: `Bearer.${token}`,
      });
    },
  );
  s5.result.serverStderr = s5.serverStderr.slice(0, 400);
  out.results.push(s5.result);

  // Scenario 6: loopback, token in URL query string ?token=<TOKEN>.
  console.error("[ws] scenario 6: loopback, token in URL query");
  const s6 = await withServer(
    [
      "app-server",
      "--listen",
      "ws://127.0.0.1:$PORT",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      sha,
    ],
    async (port) => {
      return tryHandshake({
        scenario: "loopback-auth-query",
        url: `ws://127.0.0.1:${port}/?token=${token}`,
      });
    },
  );
  s6.result.serverStderr = s6.serverStderr.slice(0, 400);
  out.results.push(s6.result);

  // Scenario 7: loopback, token in URL query as access_token=.
  console.error("[ws] scenario 7: loopback, ?access_token=");
  const s7 = await withServer(
    [
      "app-server",
      "--listen",
      "ws://127.0.0.1:$PORT",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      sha,
    ],
    async (port) => {
      return tryHandshake({
        scenario: "loopback-auth-query-access-token",
        url: `ws://127.0.0.1:${port}/?access_token=${token}`,
      });
    },
  );
  s7.result.serverStderr = s7.serverStderr.slice(0, 400);
  out.results.push(s7.result);

  // Scenario 8: NON-loopback (0.0.0.0), --ws-auth capability-token,
  // Authorization header. Connect to 127.0.0.1 because that resolves
  // to the same socket. This tests whether non-loopback enforces auth.
  console.error("[ws] scenario 8: 0.0.0.0 bind, Authorization header");
  const s8 = await withServer(
    [
      "app-server",
      "--listen",
      "ws://0.0.0.0:$PORT",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      sha,
    ],
    async (port) => {
      return tryHandshake({
        scenario: "non-loopback-auth-header",
        url: `ws://127.0.0.1:${port}`,
        authHeader: `Bearer ${token}`,
      });
    },
  );
  s8.result.serverStderr = s8.serverStderr.slice(0, 400);
  out.results.push(s8.result);

  // Scenario 9: NON-loopback, NO token at all (must be refused).
  console.error("[ws] scenario 9: 0.0.0.0 bind, NO token (must fail)");
  const s9 = await withServer(
    [
      "app-server",
      "--listen",
      "ws://0.0.0.0:$PORT",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      sha,
    ],
    async (port) => {
      return tryHandshake({
        scenario: "non-loopback-no-token",
        url: `ws://127.0.0.1:${port}`,
      });
    },
  );
  s9.result.serverStderr = s9.serverStderr.slice(0, 400);
  out.results.push(s9.result);

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("[ws] fatal:", e);
  process.exit(1);
});
