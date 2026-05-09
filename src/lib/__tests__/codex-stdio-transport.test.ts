// P64 — stdio transport integration tests.
//
// Spawns a tiny Node script that mimics the codex app-server JSON-RPC
// surface (initialize handshake + a turn that streams a few items).
// Verifies:
//   - Transport spawns the child + handles stdin/stdout framing
//   - Newline-delimited JSON in/out works in both directions
//   - stderr lines surface as `log` notifications
//   - close() terminates the child cleanly
//   - missing binary surfaces a helpful ENOENT-derived error
//
// We deliberately don't hit the real `codex` binary — the fake script
// is dependency-free and runs anywhere Node does, so this test is
// valid in CI.

import { writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

const FAKE_SERVER = `#!${process.execPath}
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
function send(env) { process.stdout.write(JSON.stringify(env) + "\\n"); }
process.stderr.write("fake-codex starting\\n");
rl.on("line", line => {
  let env;
  try { env = JSON.parse(line); } catch { return; }
  if (env.method === "initialize") {
    send({ jsonrpc: "2.0", id: env.id, result: { serverInfo: { name: "fake-codex" } } });
  } else if (env.method === "ping") {
    send({ jsonrpc: "2.0", id: env.id, result: { pong: true } });
  } else if (env.method === "stream") {
    // Emit two notifications + a final response.
    send({ jsonrpc: "2.0", method: "log", params: { level: "info", message: "n=1" } });
    send({ jsonrpc: "2.0", method: "log", params: { level: "info", message: "n=2" } });
    send({ jsonrpc: "2.0", id: env.id, result: { count: 2 } });
  } else {
    send({ jsonrpc: "2.0", id: env.id, error: { code: -32601, message: "method not found" } });
  }
});
rl.on("close", () => process.exit(0));
`;

(async () => {
  // Materialise the fake server as an executable file.
  const dir = mkdtempSync(join(tmpdir(), "codex-stdio-test-"));
  const fakePath = join(dir, "fake-codex.js");
  writeFileSync(fakePath, FAKE_SERVER);
  chmodSync(fakePath, 0o755);

  // Override the codex command to our fake script. We can't pass the
  // path to createStdioTransport directly via CODEX_BIN because the
  // stdio transport reads it lazily; pass via opts.command instead.
  const transportPath = require.resolve("../codex/transport");
  delete (require as any).cache[transportPath];
  const { createStdioTransport } = require("../codex/transport");

  // ─── happy path: spawn → initialize → stream → close ─────────────
  {
    const transport = await createStdioTransport({
      command: process.execPath,
      args: [fakePath],
    });

    const messages: any[] = [];
    transport.onMessage((m: any) => messages.push(m));

    // Send initialize.
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "test" } } });
    await new Promise(r => setTimeout(r, 200));
    const initResp = messages.find(m => m.id === 1);
    pass("transport spawns child + handshakes",
      !!initResp && initResp.result?.serverInfo?.name === "fake-codex");

    // ping/pong correlation.
    await transport.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    await new Promise(r => setTimeout(r, 100));
    const pingResp = messages.find(m => m.id === 2);
    pass("ping/pong round-trip", pingResp?.result?.pong === true);

    // stream emits log notifications + a final response.
    await transport.send({ jsonrpc: "2.0", id: 3, method: "stream" });
    await new Promise(r => setTimeout(r, 200));
    const logs = messages.filter(m => m.method === "log");
    const streamResp = messages.find(m => m.id === 3);
    pass("stream notifications interleave with response",
      logs.length >= 2 && streamResp?.result?.count === 2);

    // stderr lines arrive as `log` notifications (we wrote
    // "fake-codex starting" on startup).
    const stderrLogs = logs.filter(l => l.params?.source === "codex-stderr");
    pass("stderr forwarded as log notifications",
      stderrLogs.some(l => /fake-codex starting/.test(l.params?.message || "")));

    // close() shuts down cleanly.
    let closedCalled = false;
    transport.onClose(() => { closedCalled = true; });
    await transport.close();
    await new Promise(r => setTimeout(r, 200));
    pass("close() terminates the child + fires onClose", closedCalled === true);

    // After close, send() should reject.
    let rejected = false;
    try { await transport.send({ jsonrpc: "2.0", id: 99, method: "ping" }); }
    catch { rejected = true; }
    pass("send() after close rejects", rejected === true);
  }

  // ─── missing binary surfaces a helpful error ─────────────────────
  {
    let err: Error | null = null;
    try {
      await createStdioTransport({
        command: "/this/binary/does/not/exist/codex",
        args: ["app-server"],
      });
    } catch (e: any) {
      err = e;
    }
    pass("missing binary throws a helpful error",
      !!err && /not found|launch/i.test(err.message || ""));
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll stdio-transport tests passed.");
})();
