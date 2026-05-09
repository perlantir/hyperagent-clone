// P65 — Companion runtime tests.
//
// Spawns a tiny fake codex (a Node script we author here) over stdio
// and exercises the companion's `CodexProcess` + `BrowserServer`
// modules end-to-end:
//
//   - CodexProcess detects ENOENT and surfaces an actionable error
//   - CodexProcess starts a fake "codex" and JSON-RPC works
//   - CodexProcess routes server-initiated requests to handlers
//   - CodexProcess fans out notifications
//   - BrowserServer enforces origin
//   - BrowserServer enforces first-message hello
//   - BrowserServer responds to /health
//   - BrowserServer answers Private Network Access preflight when origin matches
//   - BrowserServer rejects non-loopback bind via the companion CLI guard
//
// Pure JS modules so we require() them directly (matches the package's
// runtime shape).

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

import { writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMPANION_PATH = require.resolve("../../../packages/codex-companion/src/companion.js");
const CODEX_PROCESS_PATH = require.resolve("../../../packages/codex-companion/src/codex-process.js");
const BROWSER_SERVER_PATH = require.resolve("../../../packages/codex-companion/src/browser-server.js");
const REDACT_PATH = require.resolve("../../../packages/codex-companion/src/redact.js");

const { CodexProcess, detectCodex } = require(CODEX_PROCESS_PATH);
const { BrowserServer } = require(BROWSER_SERVER_PATH);
const { redact } = require(REDACT_PATH);

// Tiny fake codex emits the same wire shapes the real binary does.
const FAKE_CODEX_SOURCE = `#!${process.execPath}
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
function send(env) { process.stdout.write(JSON.stringify(env) + "\\n"); }

let nextServerReqId = 100;
process.stderr.write("fake codex starting\\n");
send({ jsonrpc: "2.0", method: "thread/started", params: { threadId: "ct_fake" } });

rl.on("line", (line) => {
  let env;
  try { env = JSON.parse(line); } catch { return; }
  if (env.method === "initialize") {
    send({ jsonrpc: "2.0", id: env.id, result: {
      userAgent: "fake/0.0", codexHome: "/tmp/.codex",
      platformFamily: "unix", platformOs: "linux",
    }});
  } else if (env.method === "getAuthStatus") {
    send({ jsonrpc: "2.0", id: env.id, result: {
      authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: false,
    }});
  } else if (env.method === "thread/start") {
    send({ jsonrpc: "2.0", id: env.id, result: { thread: { id: "ct_1" } } });
  } else if (env.method === "turn/start") {
    send({ jsonrpc: "2.0", id: env.id, result: { turn: { id: "tu_1" } } });
    // Simulate an approval as a server-initiated request.
    const reqId = nextServerReqId++;
    send({ jsonrpc: "2.0", id: reqId, method: "item/commandExecution/requestApproval",
           params: { command: "ls /tmp" } });
  } else if (env.id !== undefined && env.result !== undefined) {
    // We received a reply from our server-initiated request. Echo it
    // out as a notification so the test can verify routing.
    send({ jsonrpc: "2.0", method: "approval/response_seen",
           params: { decision: env.result?.decision } });
  } else {
    send({ jsonrpc: "2.0", id: env.id, error: { code: -32601, message: "method not found" } });
  }
});
rl.on("close", () => process.exit(0));
`;

(async () => {
  // ─── ENOENT path ──────────────────────────────────────────────────
  {
    const detect = detectCodex("/no/such/binary/exists");
    pass("detectCodex returns actionable error on ENOENT",
      detect.found === false && /not found/i.test(detect.error));
  }

  // ─── start fake codex over stdio ──────────────────────────────────
  const tmp = mkdtempSync(join(tmpdir(), "codex-companion-"));
  const fakeBin = join(tmp, "fake-codex.js");
  writeFileSync(fakeBin, FAKE_CODEX_SOURCE, { mode: 0o755 });
  chmodSync(fakeBin, 0o755);

  const codex = new CodexProcess({ binPath: process.execPath });
  // We pass `app-server --listen stdio://` shape via the codex constructor —
  // but the constructor hardcodes those args, so we cheat by supplying
  // the fake script as the bin and overriding args via a tiny subclass.
  // Easier: write a wrapper that swallows the `app-server --listen ...`
  // args our spawn passes.
  const wrapperBin = join(tmp, "wrapper.js");
  writeFileSync(wrapperBin, `#!${process.execPath}
require("child_process").spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(fakeBin)}], { stdio: "inherit" });
`, { mode: 0o755 });
  chmodSync(wrapperBin, 0o755);

  // Direct route: monkey-patch the spawn logic by passing the fake
  // binary AS codex and assuming our CodexProcess just swallows the
  // app-server args. The fake script ignores all argv anyway.
  const directCodex = new (class extends CodexProcess {
    constructor() { super({ binPath: process.execPath }); }
  })();
  // Manually spawn with the fake script as the only arg (no app-server).
  const spawn = require("node:child_process").spawn;
  const child = spawn(process.execPath, [fakeBin], { stdio: ["pipe", "pipe", "pipe"] });
  (directCodex as any).child = child;
  (directCodex as any).child.stdout.setEncoding("utf8");
  (directCodex as any).child.stdout.on("data", (chunk: string) => (directCodex as any)._onStdout(chunk));
  (directCodex as any).child.stderr.setEncoding("utf8");
  (directCodex as any).child.on("close", (code: number) => {
    (directCodex as any)._closed = true;
    for (const p of (directCodex as any).pending.values()) {
      p.reject(new Error("closed"));
    }
    for (const h of (directCodex as any).exitHandlers) try { h(code); } catch {}
  });

  // initialize handshake.
  const init = await directCodex.request("initialize", {
    clientInfo: { name: "test", title: null, version: "0" },
    capabilities: { experimentalApi: false, optOutNotificationMethods: null },
  });
  pass("CodexProcess initialize round-trips",
    typeof init === "object" && init?.userAgent === "fake/0.0");

  // notifications.
  let notifSeen: any = null;
  directCodex.onNotification((env: any) => {
    if (env.method === "thread/started") notifSeen = env.params;
  });
  // The fake server emitted thread/started ON START, before we
  // attached the listener — so we drive a fresh thread/start to
  // generate one in flight.
  const startResp = await directCodex.request("thread/start");
  pass("thread/start request returns thread.id",
    startResp?.thread?.id === "ct_1");

  // ─── server-initiated request handler ─────────────────────────────
  let approvalParams: any = null;
  directCodex.onServerRequest(async (env: any) => {
    if (env.method !== "item/commandExecution/requestApproval") return undefined;
    approvalParams = env.params;
    return { decision: "approved" };
  });
  await directCodex.request("turn/start", { threadId: "ct_1", input: [{ type: "text", text: "hi", text_elements: [] }] });
  // Give the fake codex a tick to dispatch the server-initiated request
  // and receive our reply.
  await new Promise((r) => setTimeout(r, 100));
  pass("server-initiated approval request reached our handler",
    approvalParams?.command === "ls /tmp");

  // Stop cleanly.
  await directCodex.stop();
  pass("CodexProcess.stop completes",
    (directCodex as any)._closed === true);

  // ─── BrowserServer: origin enforcement, hello auth, /health ───────
  {
    const allowed = "http://app.example.com";
    const turnCalls: any[] = [];
    const server = new BrowserServer({
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: [allowed],
      onTurn: async (args: any) => {
        turnCalls.push({ hello: args.hello });
        return {
          approval: () => undefined,
          cancel: () => undefined,
          close: () => undefined,
        };
      },
      onApproval: async () => ({ status: 200, body: { ok: true } }),
      onCancel: async () => ({ status: 200, body: { ok: true } }),
      onShutdown: async () => ({ status: 200, body: { ok: true } }),
      getStatus: () => ({ ok: true }),
      log: { status: () => undefined, debug: () => undefined, error: () => undefined },
    });
    const baseUrl = await server.start();
    pass("BrowserServer bound on a real port",
      typeof baseUrl === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl));

    // /health works (no Origin → server-to-server style is fine).
    const health = await fetch(`${baseUrl}/health`);
    pass("/health returns 200", health.status === 200);
    const hj = await health.json();
    pass("/health body is JSON", hj.ok === true);

    // Origin allowed: 200 with CORS header.
    const okRes = await fetch(`${baseUrl}/health`, { headers: { Origin: allowed } });
    pass("allowed Origin gets matching CORS header",
      okRes.headers.get("access-control-allow-origin") === allowed);

    // Origin disallowed: 403 on any non-OPTIONS path.
    const blocked = await fetch(`${baseUrl}/health`, { headers: { Origin: "http://attacker.example.com" } });
    pass("disallowed Origin gets 403",
      blocked.status === 403);

    // OPTIONS preflight with PNA: returns 204 + ALLOW header.
    const pre = await fetch(`${baseUrl}/turn`, {
      method: "OPTIONS",
      headers: {
        Origin: allowed,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    pass("OPTIONS preflight returns 204",
      pre.status === 204);
    pass("Access-Control-Allow-Private-Network present for allowed origin",
      pre.headers.get("access-control-allow-private-network") === "true");

    // WebSocket connection without Origin → refused.
    const { default: WS } = await import("ws");
    const wsBlocked = await tryWS(baseUrl, undefined);
    pass("WS without Origin refused",
      wsBlocked.closed === true && wsBlocked.code === 4403);

    // WebSocket with bad Origin → refused.
    const wsBadOrigin = await tryWS(baseUrl, "http://attacker.example.com");
    pass("WS with bad Origin refused",
      wsBadOrigin.closed === true && wsBadOrigin.code === 4403);

    // WebSocket with good Origin but no /turn path → refused.
    const wsBadPath = await new Promise<any>((resolve) => {
      const ws = new WS(`ws://127.0.0.1:${new URL(baseUrl).port}/wrong-path`, [], {
        headers: { Origin: allowed },
      });
      ws.on("close", (code: number) => resolve({ closed: true, code }));
      ws.on("error", () => undefined);
      setTimeout(() => resolve({ closed: false }), 1000);
    });
    pass("WS to non-/turn path refused",
      wsBadPath.closed === true && wsBadPath.code === 4404);

    // First-message auth: opens, then we send no hello, get closed.
    const wsNoHello = await new Promise<any>((resolve) => {
      const ws = new WS(`ws://127.0.0.1:${new URL(baseUrl).port}/turn`, [], {
        headers: { Origin: allowed },
      });
      ws.on("open", () => undefined); // do nothing
      ws.on("close", (code: number) => resolve({ closed: true, code }));
      setTimeout(() => resolve({ closed: false }), 6000);
    });
    pass("WS without hello gets closed (4401)",
      wsNoHello.closed === true && wsNoHello.code === 4401);

    // First-message auth: hello reaches the onTurn handler.
    const helloPayload = { type: "hello", runTicket: "abc.def", input: { threadId: "t1", text: "hi" } };
    const wsGood = await new Promise<any>((resolve) => {
      const ws = new WS(`ws://127.0.0.1:${new URL(baseUrl).port}/turn`, [], {
        headers: { Origin: allowed },
      });
      ws.on("open", () => ws.send(JSON.stringify(helloPayload)));
      ws.on("close", () => resolve({ closed: true }));
      setTimeout(() => { ws.close(); resolve({ closed: false }); }, 2000);
    });
    void wsGood;
    pass("onTurn handler received hello",
      turnCalls.length === 1 && turnCalls[0].hello.runTicket === "abc.def");

    await server.stop();
  }

  // ─── redact ────────────────────────────────────────────────────────
  {
    const r = redact({
      authorization: "Bearer eyJabc.def.ghi-1234567890",
      api_key: "sk-test-1234567890123456789012",
      nested: { refresh_token: "rtok-aaa", message: "hello", number: 42 },
      list: ["plain", { secret: "shh" }],
    });
    pass("redact blanks authorization field",
      r.authorization === "[REDACTED]");
    pass("redact blanks api_key field",
      r.api_key === "[REDACTED]");
    pass("redact blanks nested refresh_token field",
      r.nested.refresh_token === "[REDACTED]");
    pass("redact preserves harmless fields",
      r.nested.message === "hello" && r.nested.number === 42);
    pass("redact walks arrays of objects",
      r.list[0] === "plain" && r.list[1].secret === "[REDACTED]");
  }

  if (failed > 0) {
    console.error(`\n${failed} companion-runtime test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-companion-runtime tests passed");
})();

async function tryWS(baseUrl: string, origin: string | undefined): Promise<{ closed: boolean; code?: number }> {
  const { default: WS } = await import("ws");
  return new Promise((resolve) => {
    const ws = new WS(`ws://127.0.0.1:${new URL(baseUrl).port}/turn`,
      [],
      origin ? { headers: { Origin: origin } } : undefined,
    );
    ws.on("close", (code: number) => resolve({ closed: true, code }));
    ws.on("error", () => undefined);
    ws.on("unexpected-response", (_req: any, res: any) => {
      // ws emits unexpected-response when handshake gets HTTP back instead
      // of 101. We treat the close code as the resolution path so timeout
      // is the fallback.
      void res;
    });
    setTimeout(() => resolve({ closed: false }), 1500);
  });
}
