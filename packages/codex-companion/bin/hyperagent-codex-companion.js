#!/usr/bin/env node
//
// hyperagent-codex-companion — local companion for the Hyperagent
// hosted app's Codex Companion mode (P65 experimental alpha).
//
// Usage:
//
//   npx hyperagent-codex-companion <pair-code>
//   npx hyperagent-codex-companion <pair-code> --host=https://app.example.com --port=8390
//
// Flags:
//
//   --host=<url>     Hosted Hyperagent base URL. Defaults to
//                    HYPERAGENT_HOST env var. The companion calls this
//                    URL to claim the pair-code, heartbeat, and mirror
//                    events.
//
//   --port=<n>       Local port the companion should bind to. Defaults
//                    to a free port chosen at startup. Always binds
//                    127.0.0.1; never 0.0.0.0 unless --bind=0.0.0.0
//                    is passed explicitly (and then warns loudly).
//
//   --bind=<host>    Override the bind address. Default 127.0.0.1.
//                    Setting anything other than 127.0.0.1 / ::1
//                    requires the user to confirm with --i-understand.
//
//   --codex=<path>   Override the codex binary path. Defaults to
//                    `codex` on PATH. Use this if codex is not on
//                    PATH or you have multiple installs.
//
//   --no-spawn       Don't spawn `codex app-server`; expect it to be
//                    running already. Useful for development. The
//                    companion still owns the connection.
//
// SECURITY:
//   - We never log the pair-code, session secret, run ticket, or
//     access tokens. Even on -v / DEBUG=1.
//   - Browser traffic must come from an allow-listed origin matching
//     the hosted app's URL (the --host arg). Other origins get a 403
//     on the first message and the WebSocket is closed.

const { runCompanion } = require("../src/companion.js");

const argv = process.argv.slice(2);
const opts = parseArgs(argv);

if (opts.help || (!opts.pairCode && !opts.statusOnly)) {
  printHelp();
  process.exit(opts.help ? 0 : 1);
}

runCompanion(opts).catch((err) => {
  console.error("[companion] fatal:", err && err.message ? err.message : err);
  process.exit(1);
});

function parseArgs(argv) {
  const out = {
    pairCode: "",
    host: process.env.HYPERAGENT_HOST || "",
    port: 0,
    bind: "127.0.0.1",
    codex: process.env.CODEX_BIN || "codex",
    spawn: true,
    iUnderstand: false,
    help: false,
    statusOnly: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--no-spawn") out.spawn = false;
    else if (arg === "--i-understand") out.iUnderstand = true;
    else if (arg === "--status") out.statusOnly = true;
    else if (arg.startsWith("--host=")) out.host = arg.slice("--host=".length);
    else if (arg.startsWith("--port=")) out.port = Number(arg.slice("--port=".length)) || 0;
    else if (arg.startsWith("--bind=")) out.bind = arg.slice("--bind=".length);
    else if (arg.startsWith("--codex=")) out.codex = arg.slice("--codex=".length);
    else if (!arg.startsWith("-") && !out.pairCode) out.pairCode = arg;
  }
  return out;
}

function printHelp() {
  process.stdout.write(`hyperagent-codex-companion — local companion for Hyperagent's Codex mode

Usage:
  npx hyperagent-codex-companion <pair-code> [options]

Options:
  --host=<url>      Hosted Hyperagent base URL (or HYPERAGENT_HOST env)
  --port=<n>        Local port to bind (default: ephemeral)
  --bind=<host>     Bind host (default: 127.0.0.1)
  --codex=<path>    Path to the codex binary (default: 'codex' on PATH)
  --no-spawn        Don't spawn codex; expect a running instance
  --status          Print local status and exit
  --i-understand    Required if --bind is non-loopback
  -h, --help        Show this help

Notes:
  • The companion binds to loopback only by default. The hosted app
    can't reach your laptop directly; the BROWSER on your laptop
    connects to the companion.
  • Codex auth (ChatGPT login or API key) is owned by the codex
    binary, NOT this companion. We never store or read those tokens.
  • This is an experimental alpha. Run \`hyperagent-codex-companion
    --status\` to see what's currently running.
`);
}
