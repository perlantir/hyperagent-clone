# hyperagent-codex-companion (alpha)

Local companion that bridges the hosted Hyperagent app to a locally-running OpenAI Codex `app-server`. The hosted app cannot reach your machine directly, so this companion runs on your laptop and exposes a loopback HTTP/WebSocket surface that the browser tab driving Hyperagent connects to.

**Status: experimental alpha.** Do not rely on this for production workflows yet.

## Why a companion?

The Codex `app-server` enforces auth on its WebSocket via the `Authorization: Bearer <token>` HTTP header. **Browsers cannot set arbitrary headers on `WebSocket` connections.** A browser therefore cannot speak directly to a properly-secured Codex `app-server`. The companion sits in the middle:

```
Hosted Hyperagent app  ──>  Browser tab  ──>  Companion (loopback)  ──>  codex app-server  ──>  ChatGPT/Codex auth
```

The companion runs on your machine, so it CAN set the Authorization header. The browser's WS handshake to the companion uses our own short-lived run-ticket scheme instead of arbitrary headers.

## Install

The companion is published as `hyperagent-codex-companion`. The recommended way to run it is via `npx`, no install required:

```sh
npx hyperagent-codex-companion <pair-code>
```

## Usage

1. Sign in to the hosted Hyperagent app.
2. Go to **Settings → Codex**.
3. Pick **Codex Companion** (Experimental).
4. Click **Generate pair code**. A command is shown:
   ```
   npx hyperagent-codex-companion <pair-code> --host=https://app.example.com
   ```
5. Paste it into a terminal on the same machine where you run Codex.
6. The companion claims the pair code with the hosted app, starts Codex, and waits for the browser to connect.
7. The hosted app's UI flips to "Companion online — Codex ready". Run a chat turn from the browser as normal.

## Flags

| Flag | Default | Notes |
|------|---------|-------|
| `--host=<url>` | `$HYPERAGENT_HOST` | Hosted Hyperagent base URL (the app you're signed in to). |
| `--port=<n>` | ephemeral | Local port. Always bound to 127.0.0.1. |
| `--bind=<host>` | `127.0.0.1` | Bind host. Anything other than `127.0.0.1` / `::1` / `localhost` requires `--i-understand`. |
| `--codex=<path>` | `codex` (PATH) | Path to the codex binary. Use this if you have multiple installs. |
| `--no-spawn` | spawn enabled | Don't start `codex app-server`; expect it running externally. |
| `--status` | — | Print local status to stdout and exit. |

## Security model

- **Loopback only by default.** The companion binds to `127.0.0.1`. The hosted app cannot reach this URL — only your browser tab can.
- **Codex never speaks to the browser.** The companion is the only thing the browser sees; codex stays behind it on stdio.
- **No long-lived tokens in URLs.** The browser passes a server-issued run ticket in the first WebSocket message body, never as a query string.
- **Origin checks.** Only requests whose `Origin` matches your hosted app are accepted.
- **Private Network Access preflight.** The companion responds with `Access-Control-Allow-Private-Network: true` only for the configured allowed origin.
- **Pair codes are short-lived.** 5-minute window; one-time-use; SHA-256 hashed server-side.
- **Session secret never echoed.** The hosted app returns it once on claim; from then on the companion uses it only in heartbeat and event-mirror requests.
- **Codex auth is owned by codex.** The companion never reads, stores, or proxies your ChatGPT access/refresh/ID tokens. Auth lives in `~/.codex/`.
- **Logs never include pair codes, session secrets, run tickets, Authorization headers, access tokens, or callback URLs.** Defense-in-depth redaction runs on every line printed to stdout/stderr.

## What's NOT in this alpha

- Hard budget enforcement. The hosted app shows budgets as **advisory** in companion mode; real billing is on your ChatGPT plan.
- Cross-tab survival. Closing the browser tab during a turn may abandon the run; re-opening reconnects but does not resume.
- Hosted relay. P66 will introduce an outbound-only relay so the companion can talk to the hosted app over a server-managed control plane instead of inbound localhost.
- Multi-machine companions. Currently one companion at a time per user/session.

## Disconnecting

- In the hosted app: **Settings → Codex → Disconnect companion**. The next heartbeat from the companion gets a 410 and the companion exits.
- On your machine: `Ctrl+C` in the companion terminal. The companion revokes its session before exiting.

## Troubleshooting

- **"Codex binary not found"** — install `codex` from https://github.com/openai/codex and ensure it's on PATH, or pass `--codex=/path/to/codex`.
- **"Codex auth: needs_login"** — run `codex auth login` in another terminal, then re-run the companion.
- **Browser shows "Waiting for companion"** — confirm the companion terminal shows `paired` and `running`. Check the companion's URL with `--status`.
- **"403 origin_not_allowed" from companion** — the hosted app URL you're signed in to doesn't match the `--host` argument. Pass the correct origin.
- **Browser doesn't see localhost** — Chrome PNA may be blocking; verify your hosted app is served over HTTPS (PNA only allows secure origins to talk to private networks). Open DevTools → Network → Console for the exact preflight error.

## Development

Source lives in `hyperagent-clone/packages/codex-companion`. Run unit tests against the project from the monorepo root with `npm run test:codex`.
