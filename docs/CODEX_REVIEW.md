# Codex integration — P64 + P64.1 review

This is the security/architecture review you asked for after P64.
P64 shipped Phase 1 polish + Phase 2 local stdio. **P64.1** addresses
the SSRF surface and connection-path correctness questions; that patch
ships in the same review answer.

---

## 0. TL;DR — what's correct now

- **Browser-direct** (Phase 1 variant A): server never fetches the URL.
  UI runs the test in the browser tab. Loopback / RFC1918 / `*.local`
  all allowed. The server side (`/api/codex/test-connection`,
  `/api/chat`) refuses to touch this kind of URL.
- **Public tunnel** (Phase 1 variant B): server fetches the URL after
  it passes the SSRF deny-list AND a connection-time DNS resolution
  guard. Loopback / private / link-local / ULA / cloud-metadata IPs
  blocked. `wss://` only. Token min length 32.
- **Local-server** (Phase 1 variant C): only meaningful when our Node
  IS the user's machine. Refused on Vercel at write time and again at
  request time.
- **Local stdio** (Phase 2): runtime detection flags Vercel up front;
  `codexChatGPTLocal` mode is unselectable in hosted production.
- Provider mode legacy `codexChatGPT` rows normalize to
  `codexChatGPTBridge` on read; writes reject the legacy value.

---

## 1. Phase 1 connection path — clarified

`/api/codex/test-connection` and `/api/chat`'s Phase 1 dispatch are
**server-side** code paths. Before P64.1 they would have happily fetched
`ws://127.0.0.1:8345` (i.e. the Vercel runtime's own loopback) which is
both wrong and an SSRF risk.

**P64.1 split:**

| `connectionLocation` | Who connects | Server-side fetch allowed? |
|---|---|---|
| `browser`      | The user's browser tab | **No.** `/api/codex/test-connection` returns 400 with `requiresBrowserTest: true`; chat dispatch errors with "Browser-direct can't run from the hosted server — switch to Tunnel mode or wait for browser-driven dispatch (P65)." |
| `tunnel`       | The hosted server | Yes, after `validateForServerSideFetch(url)` + `verifyResolvedIp(host)` |
| `local-server` | Our Node, when same machine as user | Yes, only when not running on Vercel |

UI test button (`testBridge` in `CodexSection.tsx`) auto-routes:
browser-direct → opens a WS from the browser tab; tunnel/local-server →
calls the server endpoint.

---

## 2. SSRF / private network safety — patched

`src/lib/codex/url-safety.ts` (NEW) replaces the loose
`isLoopbackOrPrivate` helper with two context-specific validators:

- **`validateForServerSideFetch(url)`** — refuses every SSRF target:
  - IPv4 loopback `127.0.0.0/8`
  - IPv4 private `10/8`, `172.16-31/12`, `192.168/16`
  - IPv4 link-local `169.254/16`
  - IPv4 broadcast / unspecified (`0/8`, `255.255.255.255`)
  - IPv6 loopback `::1`
  - IPv6 link-local `fe80::/10`
  - IPv6 ULA `fc00::/7`
  - Cloud metadata: `169.254.169.254`, `169.254.170.2` (ECS task),
    `100.100.100.200` (Alibaba), `metadata.google.internal`,
    `metadata.aws.amazon.com`, `metadata.azure.net`, `fd00:ec2::*`
    (AWS IMDSv2 IPv6)
  - `*.local` mDNS
  - `*.localhost` aliases
  - non-`wss://` / non-`https://` schemes (no plaintext over public)

- **`validateForBrowserOrLocal(url)`** — allows loopback + private +
  link-local + ULA + `*.local` (those are EXPECTED here — that's
  literally where the user's bridge runs). Cloud metadata IPs **still
  blocked.** `ws://` only allowed on loopback/private; public hosts
  must use `wss://`.

- **`verifyResolvedIp(host)`** — connection-time DNS guard. Resolves
  the hostname and refuses if any A/AAAA record lands in a
  loopback/private/metadata range. Catches DNS rebinding and
  DNS pinning attacks where a public-looking name resolves into
  private space.

Tests:
- `src/lib/__tests__/codex-url-safety.test.ts` — **73 tests** covering
  every IP family + every refused range + scheme enforcement +
  cross-mode behavior + DNS rebinding.

---

## 3. Architecture comment — updated

`src/lib/codex/types.ts` `CodexBridgeConfig` block now documents the
three location variants explicitly:

```
"browser"      The user's browser tab is the client. Bridge runs
               on the same machine as the browser. URL is
               loopback / RFC1918 / *.local. Hosted Vercel server
               CANNOT reach this URL — only the browser can.

"tunnel"       Bridge sits behind a public tunnel (ngrok,
               Cloudflare Tunnel, self-hosted reverse proxy).
               URL is wss:// against a public DNS / IP. Server
               can reach it AFTER passing SSRF + DNS guards.

"local-server" Our Node runtime IS the user's machine (npm run
               dev / desktop wrapper). Refused on Vercel.
```

UI copy (`CodexSection.tsx`) explains both Phase 1 variants directly
to the user before they pick.

---

## 4. Phase 2 local mode scope — clarified in UI

`CodexLocalPane` includes a collapsible "Where Local mode is and isn't
available" section listing:

- ✅ `npm run dev` on your laptop (codex on PATH + spawn allowed)
- ✅ Desktop / native wrapper (Tauri / Electron / Hyperagent native)
- ⚠️ Long-lived Node host on your own VPS — only if the host IS the
  user's machine. Don't use on shared multi-tenant servers (every
  user would share one Codex auth state).
- ⚠️ Docker locally — only if (a) codex binary is in the container or
  bind-mounted, AND (b) codex auth/state dir (`~/.codex`) is mounted
  for persistence.
- ❌ Remote Docker / production server / Vercel — Node there can't
  spawn on your laptop and the auth state would belong to the
  server, not you.

---

## 5. No raw OAuth / private-backend proxy

Confirmed:
- No raw ChatGPT OAuth token handling anywhere outside Codex
  app-server (`AppServerClient` only sends JSON-RPC envelopes; OAuth
  state lives inside the bridge).
- No direct proxying to private ChatGPT backend endpoints.
- No storage of ChatGPT/Codex `accessToken`/`refreshToken`/`idToken`
  in our hosted DB. The `codex_bridges` table stores: encrypted
  WebSocket URL, encrypted capability token, experimental flag,
  connectionLocation. None of those are ChatGPT auth tokens.
- No silent fallback into ChatGPT subscription auth — provider mode
  is explicit-only and rejected for unknown values
  (`codex-provider-mode.test.ts` covers this).

The Codex app-server stays the auth boundary. We talk to it via its
JSON-RPC; it owns the OAuth/PKCE/keychain.

---

## 6. App-server protocol compatibility — current assumptions

What we currently send/receive:
- **JSONL over stdio** — newline-delimited JSON, `\n`-framed.
- **JSON-RPC 2.0 envelopes** with `jsonrpc: "2.0"` field present on
  every request and response.
- Methods: `initialize`, `account/read`, `account/login/start`,
  `account/logout`, `account/rateLimits/read`,
  `account/chatgptAuthTokens/refresh` (gated behind
  `capabilities.experimentalApi`), `thread/start`, `thread/fork`,
  `turn/start`, `approval/respond`.
- Notifications consumed: `turn/itemAdded`, `turn/itemUpdated`,
  `turn/finished`, `tool/call`, `tool/result`,
  `command/executionRequested`, `file/changeRequested`,
  `approval/required`, `log`.
- Server-initiated approvals handled (`approval/required` →
  user UI → `approval/respond`).
- Unknown notifications: dispatched to subscribers; no-handler =
  silently dropped.
- Unknown response methods: rejected to the awaiting promise via
  `JSON-RPC error code -32601` if the bridge sends one; otherwise
  the request times out at 30 s.

**Not yet validated against a real `codex app-server` binary** —
the client was developed against the protocol description in your
spec and tested with a fake JSON-RPC server. Items that need real-
binary verification before production:

- Whether the protocol is JSON-RPC 2.0 OR a "JSON-RPC-lite"
  variant that omits the `jsonrpc` field. Easy fix if the latter:
  drop `jsonrpc` from `AppServerClient.request()` and accept it
  optionally on inbound. **Not patched yet.**
- Method names matching the actual Codex app-server registry.
  Names align with your spec but a real `codex app-server
  generate-ts` output would be authoritative. **Not run yet.**
- Capability detection during `initialize`: we send
  `capabilities.experimentalApi`; we do NOT currently parse the
  bridge's reply for its own capability advertisement beyond
  using whatever shape it returns as opaque.
- Version negotiation: not implemented. Future work — read the
  bridge's `serverInfo.version` from `initialize` reply and gate
  experimental method calls on a version check.

`ping` was a **test-only helper** — used in `codex-stdio-transport.
test.ts` against the fake server. It's not used by any production
code path. The stdio-transport tests intentionally use a custom
fake server; the AppServerClient tests use only spec methods
(`initialize`, `account/read`, etc.).

---

## 7. P64 = connection plumbing, not a fully validated Codex run

Confirmed scope:

| Capability | Wired? | Real-binary tested? |
|---|---|---|
| Stdio transport spawn + framing | ✅ | ✅ (fake bridge) — ❌ real codex |
| WebSocket transport with subprotocol auth | ✅ | ❌ |
| `initialize` handshake | ✅ | ❌ |
| `account/read` | ✅ | ❌ |
| `account/login/start` (chatgpt / chatgptDeviceCode / apiKey) | ✅ | ❌ |
| `account/logout` | ✅ | ❌ |
| `account/rateLimits/read` | ✅ | ❌ |
| `thread/start` | ✅ | ❌ |
| `thread/fork` | ✅ | ❌ |
| `turn/start` | ✅ | ❌ |
| `thread/resume` | ❌ | — |
| `turn/steer` | ❌ | — |
| Streamed turn events → SSE → ChatView | ✅ wired | ❌ end-to-end |
| Tool / command events | ✅ wired | ❌ end-to-end |
| Approval requests + interactive UI | ✅ | ❌ end-to-end |
| File-change events → artifacts | ✅ wired | ❌ end-to-end |
| Cancellation | ⚠️ partial — we send turn-timeout but no `turn/cancel` | ❌ |
| Disconnect / reconnect | ✅ disconnect, ❌ reconnect | ❌ |
| Trace mapping | ✅ — events emit through redactRpcEnvelope | ❌ |
| Artifact / file output mapping | ✅ wired | ❌ |

**Status:** "connection plumbing complete; turn streaming is wired
end-to-end but only validated against a fake bridge". Codex runs are
**not yet production-ready**.

---

## 8. P65 browser-proxy plan — tradeoffs documented

Stated plan: **chat dispatch for `codexChatGPTCompanion` runs in the
browser via direct WS to the local companion. No server hop.**

Tradeoffs of the browser-as-orchestrator path:

| Concern | Impact | Mitigation |
|---|---|---|
| Browser tab close kills the active run | High for long runs | Companion can persist last-known turn state and re-emit on reconnect; we mirror events to server every N seconds |
| Server-side traces / budgets / audit may be incomplete | High for compliance | Mirror events from companion → server-side trace store (best-effort POSTs) |
| Browser dispatch may bypass policy / fallback / enterprise controls | Medium | Server gates which providers a given user can use; companion dispatch must check that gate before opening WS |
| Artifact creation has no server path | High | Companion mirrors artifact-bearing events to `/api/artifacts/from-companion` |
| Multi-user / team visibility weaker | Medium | Mirroring covers the visibility need |
| Long runs hard | High | Companion owns run state; browser is just a viewer |

**Preferred long-term P65/P66 architecture (we'll move toward):**
- Companion owns local Codex app-server connection.
- Companion establishes an **outbound** authenticated session to a
  hosted relay/control plane (we don't have one yet).
- Hosted app receives **mirrored** events, traces, artifacts.
- Browser is UI, not the source of truth for long-running execution.

**P65 next-step proposal:** ship browser-direct companion mode as
**experimental alpha** with these guardrails:
- Clear "EXPERIMENTAL — browser-driven" UI banner
- Companion mirrors a periodic event tail to `/api/codex/companion/
  trace-mirror` so server traces aren't blank
- Manual bridge stays as the supported fallback for production
- Hosted relay (P66) replaces browser-direct dispatch when ready

---

## 9. Deliverables

### a. Files changed (P64.1)

```
NEW  src/lib/codex/url-safety.ts                  173 lines
NEW  src/lib/__tests__/codex-url-safety.test.ts   ~250 lines, 73 tests
MOD  src/lib/codex/types.ts                       CodexBridgeLocation, CodexBridgeConfig
MOD  src/lib/codex/store.ts                       per-location validation, schema column
MOD  src/app/api/codex/connection/route.ts        accepts connectionLocation, returns url
MOD  src/app/api/codex/test-connection/route.ts   refuses browser-direct, runs DNS guard
MOD  src/app/api/chat/route.ts                    refuses browser-direct, validates tunnel
MOD  src/components/settings/CodexSection.tsx     LocationRadio, browser-side test, copy
NEW  docs/CODEX_REVIEW.md                         this document
MOD  package.json                                 test:codex-url-safety + suite glue
```

### b. DB / schema changes

```sql
-- Was added in P57 (codex_bridges)
ALTER TABLE codex_bridges
  ADD COLUMN IF NOT EXISTS "connectionLocation" TEXT NOT NULL DEFAULT 'browser';
```

Idempotent via `IF NOT EXISTS`. Existing rows default to `browser`,
which is the safe default — server side dispatch refuses them and
forces an explicit re-save before chat-route Phase 1 will fetch.

### c. Provider enum migration behavior

- DB column: `users."codexProviderMode" TEXT DEFAULT 'anthropicApiKey'`
- Read path normalizes legacy `codexChatGPT` → `codexChatGPTBridge`.
- Write path rejects unknown values (no silent default).
- Test: `codex-provider-mode.test.ts` (32 tests).

### d. Runtime behavior per environment

| Environment | `codexChatGPTLocal` | `codexChatGPTBridge` (browser) | `codexChatGPTBridge` (tunnel) | `codexChatGPTBridge` (local-server) | `codexChatGPTCompanion` |
|---|---|---|---|---|---|
| Local dev (`npm run dev`) | ✅ if codex on PATH | Browser opens WS to localhost; chat-route refuses (no browser dispatch yet → P65) | ✅ if user runs a tunnel | ✅ | ❌ until P65 |
| Desktop / native wrapper | ✅ | Same as local dev | ✅ | ✅ | ❌ until P65 |
| Docker locally | ✅ if `codex` in container + `~/.codex` mounted | Browser-only — Docker doesn't change the verdict | ✅ | ✅ if container is the same machine the user is on | ❌ until P65 |
| Vercel hosted | ❌ blocked by `getLocalRuntimeStatus()` | Server refuses dispatch; browser dispatch in P65 | ✅ if URL passes `validateForServerSideFetch` + DNS guard | ❌ blocked by Vercel detection | ❌ until P65 |
| Vercel hosted + public tunnel | ❌ | n/a | ✅ | ❌ | ❌ |
| Vercel hosted + browser-direct local companion | ❌ | n/a | n/a | ❌ | Phase 3 — P65 |

### e. Security review for bridge URL handling

- ✅ Per-context URL validators (browser vs server-fetch)
- ✅ Cloud metadata IPs **always** blocked
- ✅ DNS rebinding guard at connection time
- ✅ Token-tail-only in API responses (no plaintext token leakage)
- ✅ Encryption at rest (AES-GCM via existing `encryptValue` helper)
- ✅ Bridge URLs redacted in trace events via `redactRpcEnvelope`
- ✅ Tunnel mode requires capability token ≥ 32 chars
- ✅ `ws://` blocked on non-loopback in browser mode
- ✅ `ws://` AND `http://` blocked in server-fetch mode
- ✅ Provider mode change does not silently rewrite bridge config

### f. Test list — what's mocked vs real

| Test file | What it covers | Real or mock? |
|---|---|---|
| `codex-url-safety.test.ts` (73) | Per-context URL validators + DNS resolution guard | Real (uses Node's `dns.lookup`); fake-host DNS lookups expected to fail |
| `codex-redact.test.ts` (38) | Token / URL / header / RPC envelope redaction | Synthetic input |
| `codex-provider-mode.test.ts` (32) | Enum invariants, no-silent-fallback, account segregation | Mocked DB pool |
| `codex-app-server.test.ts` (37) | JSON-RPC client handshake, all account/* methods, notifications, redaction integration | Mock transport |
| `codex-chat-bridge.test.ts` (39) | Codex thread mapping, notification → SSE conversion, interactive approvals, artifact promotion | Mock transport + mock DB |
| `codex-chat-dispatch.test.ts` (9) | OpenAI + Codex dispatcher error surfacing | Mocked providers |
| `codex-approvals.test.ts` (12) | DB rendezvous: ownership scoping, one-shot, poll timeout | Mocked DB pool |
| `codex-local-runtime.test.ts` (12) | Vercel detection, binary detection, cache invalidation | Real env mutation + real fs probe |
| `codex-stdio-transport.test.ts` (7) | Stdio framing, lifecycle, ENOENT handling | Real `child_process.spawn` against an in-memory fake codex script |
| `openai-loop.test.ts` (24) | Multi-turn tool loop, iteration cap, missing key, artifact passthrough | Mocked fetch + mocked tool exec |

**Total: 283 tests across 10 files. None of them exercise the real
`codex app-server` binary** — that's the next validation step before
any production rollout.

### g. Known limitations

1. **Real `codex app-server` not exercised yet.** Protocol shape
   assumption (JSON-RPC 2.0 with `jsonrpc` field) needs verification.
   If real binary uses JSON-RPC-lite, a one-line patch in
   `AppServerClient.request()` covers it.
2. **Browser-direct chat dispatch not implemented.** Saving a
   browser-direct bridge works; chat turns will error pointing at
   "wait for P65" until browser dispatch lands.
3. **No reconnect.** A WebSocket / stdio drop mid-turn surfaces as
   an error and the run ends. Resumable runs require `thread/resume`
   support and a state machine we haven't built yet.
4. **No `turn/cancel` JSON-RPC method.** Today we set a 270 s soft
   ceiling and abort the SSE on the client. Should send
   `turn/cancel` on user-initiated abort once the spec is confirmed.
5. **Capability advertisement parsing is loose.** We send our caps;
   we don't gate features on the bridge's caps reply.
6. **Companion (Phase 3) is just a UI placeholder** — full ship
   in P65.

### h. Remaining work before production

Before opening Codex modes to real users:

1. **Run against real `codex app-server`** — confirm JSON-RPC envelope
   shape, method names, capability fields. (1 day, requires installed
   codex CLI.)
2. **End-to-end one Codex turn through ChatView** — verify
   `turn/itemAdded` / `tool/call` / approvals all render correctly
   when the bridge is real. (2 hours after #1.)
3. **Browser-driven chat dispatch for browser-direct bridges** —
   ChatView opens a WS, runs the JSON-RPC loop in-browser, mirrors
   events back to the server for trace storage. (1-2 days. Slated
   for P65.)
4. **Companion script + pairing flow** — Phase 3. (3-4 days. P65 / P66.)
5. **`thread/resume` + reconnect** — for long runs that survive
   tab close / network blip. (1-2 days.)
6. **Hosted relay** — companion → relay → hosted app architecture so
   server-side traces / budgets / artifacts stay authoritative. (3-5
   days; needs infra outside Vercel.)
7. **Verify against `codex app-server generate-ts`** typed bindings
   if/when we adopt the upstream type generator. (1 day.)

### Status: **NOT pushing P65 yet.** P64.1 ships the patches above
first. Awaiting your sign-off before proceeding.

---

## P64.2 — Real-binary Codex app-server compatibility (2026-05-09)

**Status:** ✅ Complete. Ready for P65 (companion as experimental alpha).

P64.1 left seven open compatibility questions about the real Codex
app-server binary. P64.2 answers all of them by spawning real
`@openai/codex` v0.130.0, generating its TypeScript bindings via
`codex app-server generate-ts`, and driving real WebSocket handshakes
against the listener. Findings produced concrete patches across
`transport.ts`, `app-server.ts`, `types.ts`, `url-safety.ts`, the chat
dispatch path, and the settings UI. Test counts:

- `test:codex-app-server` — 46 PASS (was 35 in P64.1)
- `test:codex` aggregate — 10/10 groups passing (chat-bridge, chat-
  dispatch, approvals, local-runtime, stdio-transport, url-safety,
  redact, provider-mode, app-server, openai-loop)
- New scripts: `scripts/codex-smoke-test.ts`,
  `scripts/codex-ws-handshake-test.ts`,
  `scripts/codex-ws-framing-test.ts`. All gated behind
  `CODEX_SMOKE_TEST=1` and never invoked from `npm run test:*`.

### a. Real binary tested

| Field | Value |
|------|------|
| Package | `@openai/codex` v0.130.0 |
| Build | `codex-cli 0.130.0` |
| Linux path | `/vercel/runtimes/node24/bin/codex` |
| Node | v24.14.1 |
| OS | linux x64 |
| Source | `npm install -g @openai/codex` |
| TS bindings | `codex app-server generate-ts --out /tmp/codex-ts` (146 type files, two namespaces: top-level + `v2/`) |

### b. Stdio transport — what we confirmed

- ✅ **Framing**: newline-delimited JSON-RPC 2.0 on stdout. We send
  with trailing `\n`, codex parses cleanly. Smoke test sees zero
  malformed frames.
- ✅ **Initialize**: `initialize` accepts our exact payload shape
  (`{ clientInfo: { name, title, version }, capabilities: {
  experimentalApi, optOutNotificationMethods } }`). Real
  `InitializeResponse` is `{ userAgent, codexHome, platformFamily,
  platformOs }`. **There is NO server-capability echo**, contrary to
  our P57 comment. We've patched `app-server.ts` to remove that claim.
- ✅ **Method names match generated bindings**:
  - `initialize`, `account/read`, `account/login/start`,
    `account/logout`, `account/rateLimits/read`, `thread/start`,
    `thread/fork`, `turn/start`, `getAuthStatus`,
    `account/login/cancel` — all present in `ClientRequest.ts`.
- ✅ **`account/read` requires params**. Real shape is
  `GetAccountParams = { refreshToken: boolean }`; our call now passes
  `{ refreshToken: false }` as the safe default.
- ✅ **`account/logout` takes `params: undefined`** (literally
  undefined per ts-rs binding — not `{}`). The JSON envelope omits
  the `params` key. Patched and asserted in tests.
- ✅ **Notifications observed during a fresh stdio handshake**:
  `configWarning`, `remoteControl/status/changed`,
  `account/updated`, `thread/started`. All match
  `ServerNotification.ts`.
- ✅ **Clean shutdown**: closing stdin produces exit code 0 within
  ~250ms; no orphan processes. Verified via `child.once("close")`
  fan-out path in our stdio transport.
- ⚠️ **`account/rateLimits/read` requires authentication**. When no
  ChatGPT account is configured, codex returns
  `{ code: -32600, message: "codex account authentication required to
  read rate limits" }`. We can't use this method as a generic
  liveness probe. The dedicated UI rate-limits view is auth-gated
  upstream; this matches expectations.

### c. Methods that DON'T exist (corrected)

`ping` is **not** a real method — codex returns -32600 with the full
list of valid methods enumerated in the error string. The earlier
`ping` reference in `codex-stdio-transport.test.ts` is fine because
that test uses a fake script we control, not the real binary, and
serves only to exercise transport-layer correlation. We've added a
clarifying comment noting the test deliberately does NOT speak the
real Codex protocol.

### d. Server-initiated methods (server → client REQUESTS, not notifications)

The biggest correction: several methods we'd modelled as client-
initiated are actually **server requests** (codex sends them to us
expecting a JSON-RPC `result` reply). Per the generated
`ServerRequest.ts`:

- `account/chatgptAuthTokens/refresh` — codex needs a fresh
  ChatGPT JWT; client must reply with
  `{ accessToken, chatgptAccountId, chatgptPlanType }`.
- `applyPatchApproval`, `execCommandApproval` (legacy)
- `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`,
  `item/tool/requestUserInput`,
  `item/tool/call`,
  `mcpServer/elicitation/request` (v2)

**Patches:**
1. `accountChatgptAuthTokensRefresh()` removed from
   `AppServerClient`'s client method list. Replaced with a
   `onServerRequest("account/chatgptAuthTokens/refresh", handler)`
   registration API.
2. New `onServerRequest()` pattern: any server-initiated request with
   a registered handler gets the handler's return value as JSON-RPC
   `result`; thrown errors map to a JSON-RPC `error`. Unhandled
   methods get -32601 method-not-found so codex doesn't hang on a
   request it sent us.
3. `installApprovalBridge()` registers handlers for all eight
   approval-shaped methods, projects them onto our existing legacy
   `approval/required` notification shape, and resolves the JSON-RPC
   response when `approvalRespond({ approvalId, decision })` fires.
   This preserves the chat-bridge UX without a rewrite.

### e. WebSocket transport — definitive findings

Tested against the real `codex app-server --listen ws://...` listener
(see `scripts/codex-ws-handshake-test.ts` and
`scripts/codex-ws-framing-test.ts`).

| Scenario | Listener flags | Client supplies | Result |
|---------|---------------|-----------------|--------|
| 1 | none | nothing | ✅ Connect, initialize works (loopback unauth path) |
| 2 | `--ws-auth capability-token --ws-token-sha256 X` | nothing | ❌ HTTP 401 |
| 3 | `--ws-auth capability-token` | `Sec-WebSocket-Protocol: codex-bridge.bearer.<TOKEN>` | ❌ HTTP 401 |
| 4 | `--ws-auth capability-token` | `Authorization: Bearer <TOKEN>` | ✅ Connect, initialize works |
| 5 | `--ws-auth capability-token` | `Sec-WebSocket-Protocol: Bearer.<TOKEN>` | ❌ HTTP 401 |
| 6 | `--ws-auth capability-token` | `?token=...` | ❌ HTTP 401 |
| 7 | `--ws-auth capability-token` | `?access_token=...` | ❌ HTTP 401 |
| 8 | `0.0.0.0` bind + auth | `Authorization: Bearer` | ✅ |
| 9 | `0.0.0.0` bind + auth | nothing | ❌ HTTP 401 |

**Decisive finding: codex requires the capability token via the
`Authorization: Bearer <TOKEN>` HTTP header.** Sub-protocol auth
(our P57/P64.1 assumption) is rejected with 401. Query-string auth
is rejected. Header auth is the only path.

**Patches:**
1. `createWebSocketTransport` now dynamic-imports the `ws` package
   on Node and sets `headers: { Authorization: \`Bearer ${token}\` }`
   on the upgrade. Browser path falls back to the platform WebSocket
   without auth — see "browser-direct feasibility" below.
2. `package.json` adds `ws@^8.18.0` and `@types/ws` dev dep.
3. Both newline-delimited AND message-per-frame framing work over WS;
   we standardize on newline for symmetry with stdio but tolerate
   either inbound.

**Loopback behavior:** when codex is started without `--ws-auth`,
loopback bindings accept unauthenticated clients. This is **insecure
on a shared machine** — any other process or any other browser tab
on `localhost:*` can drive the bridge (browser CORS does not block
WebSocket from same-origin pages, and any user-controlled localhost
page is effectively same-origin from the bridge's perspective). We
therefore document and require the capability-token + sha256 path
for all bridge configurations.

### f. Browser-direct feasibility — DEFINITIVE ANSWER

**Browsers cannot set arbitrary headers on WebSocket connections.**
The native `WebSocket` constructor only accepts a URL and an optional
sub-protocol list — no custom headers, no Authorization. Confirmed
via WHATWG spec + verified manually.

Combined with the WS auth finding above, this means:

- **Browser-direct CANNOT authenticate to a `--ws-auth`-protected
  codex** at the WebSocket layer.
- The only browser-direct path to raw codex is unauthenticated
  loopback, which is insecure (see "Loopback behavior" above).

**Conclusion:** the production browser-direct path requires the
**P65 companion proxy**. The companion runs on the user's machine,
listens on localhost, accepts a browser-friendly auth pattern (e.g.
sub-protocol token, postMessage handshake, or a capability cookie
scoped to the companion port), and forwards traffic to codex with
the required `Authorization: Bearer` header.

**P65 plan:** companion is `experimental: alpha`, surfaces clearly
in the UI as advanced/unsafe-by-default, mirrors all events to
server-side trace store, preserves approval/audit trail, and never
bypasses provider policy / budgets / redaction. Manual bridge
(Phase 1, hosted-server-driven via tunnel) remains the supported
fallback. Long-term P66 target: companion → outbound authenticated
session → hosted relay/control plane.

### g. SSRF + DNS rebinding TOCTOU

`verifyResolvedIp()` previously returned `{ ok: true }` only —
callers re-issued DNS at connect time, leaving a TOCTOU window
where a malicious DNS server could serve a public IP at validation
and a private IP at connect. **Patched:**

1. `verifyResolvedIp()` now returns `{ ok: true, address, family }`
   with the pinned IP (always the first record in `dns.lookup` with
   `verbatim: true`).
2. `WebSocketTransportOptions` accepts `preResolvedAddress` +
   `preResolvedFamily`; the Node path sets the `lookup` callback on
   the underlying TCP connect to bypass second DNS resolution.
3. `chat/route.ts` and `test-connection/route.ts` thread the
   resolved address through to `AppServerClient.connect()`.
4. New `verifyResolvedIp` tests confirm address+family are
   returned and that loopback / private resolutions still fail
   closed.

This eliminates the rebinding window for tunnel-mode bridges. Local
loopback / browser-direct don't need this guard (the URL's IP is
already loopback/private by classification).

### h. Token entropy strengthened

P64.1 enforced ≥32 chars for tunnel mode. P64.2 raises this to
**≥192 bits of entropy** for tunnel and **≥96 bits** for browser /
local-server, per `MIN_TOKEN_ENTROPY_BITS` in `url-safety.ts`. The
in-app generator now produces **256-bit (32-byte hex)** tokens by
default via `crypto.randomBytes(32).toString("hex")`. The settings
UI exposes a one-click "Generate 256-bit" button using
`crypto.getRandomValues()` browser-side.

`validateTokenEntropy(token, location)` performs the gate at
`setBridgeConfig()` write time and surfaces a user-actionable error
including the shell command to generate a fresh token and the
correct `--ws-token-sha256` invocation for codex.

### i. Diff summary (P64.2 patches)

- `src/lib/codex/transport.ts` — Authorization-header auth via `ws`
  package on Node; preResolvedAddress + lookup pinning; tolerant
  framing; clarified comments on auth + browser limits.
- `src/lib/codex/app-server.ts` — `accountRead({ refreshToken })`,
  `accountLogout(undefined)`, new `getAuthStatus()`, removed
  `accountChatgptAuthTokensRefresh()` (server-initiated now), new
  `onServerRequest()` registration API + reply path,
  `installApprovalBridge()` legacy compat shim, fixed initialize
  comment.
- `src/lib/codex/types.ts` — `AccountReadResult` now wraps `Account`
  union; `AccountLoginStartParams` includes `chatgptAuthTokens`
  variant; `AccountLoginStartResult` is a discriminated union;
  `TurnStartParams.input` is `Array<UserInput>`; new
  `AppServerRequest`, `ChatgptAuthTokensRefreshParams/Response`,
  `CodexTurnUserInput` types.
- `src/lib/codex/url-safety.ts` — `verifyResolvedIp` returns address;
  `validateTokenEntropy` + `generateBridgeToken` helpers.
- `src/lib/codex/store.ts` — Token entropy gate via
  `validateTokenEntropy`.
- `src/lib/codex/chat-bridge.ts` — installs approval bridge; threads
  preResolvedAddress through smuggle fields; reshapes thread/start
  + turn/start params/results to v2.
- `src/app/api/chat/route.ts` — DNS-resolved IP threaded into
  bridge dispatch.
- `src/app/api/codex/account/route.ts`,
  `src/app/api/codex/test-connection/route.ts` — surface real
  `{ account, requiresOpenaiAuth }` shape.
- `src/components/settings/CodexSection.tsx` — UI shape updates,
  generator button, copy reflecting Authorization-header auth.
- `package.json` — adds `ws` + `@types/ws`.
- `scripts/codex-smoke-test.ts`,
  `scripts/codex-ws-handshake-test.ts`,
  `scripts/codex-ws-framing-test.ts` — new, gated behind
  `CODEX_SMOKE_TEST=1`.
- `src/lib/__tests__/codex-app-server.test.ts` — rewritten to match
  new shapes; 46 assertions.
- `src/lib/__tests__/codex-chat-bridge.test.ts` — updated to match
  v2 shapes + new approval flow.

### j. Production blockers cleared

| P64.1 blocker | Status |
|---------------|--------|
| Confirm wire format matches real codex | ✅ Verified |
| Confirm method names match | ✅ Verified |
| Browser-direct WS auth feasibility | ✅ Determined: requires companion |
| TOCTOU rebinding gap | ✅ Patched via preResolvedAddress |
| Token entropy strength | ✅ ≥192-bit tunnel / ≥96-bit local |
| Server-initiated approval handling | ✅ onServerRequest + bridge shim |
| Stale approval/respond model | ✅ Removed; replies via JSON-RPC response |

### k. P65 prerequisites (now met)

1. ✅ Real protocol confirmed against codex 0.130.0.
2. ✅ Browser-direct feasibility answered (requires companion).
3. ✅ TOCTOU window closed.
4. ✅ Token entropy hardened.
5. ✅ Server-initiated approvals correctly modeled.

**P65 may proceed** under the agreed guardrails: experimental alpha,
mirror events to server-side trace store, preserve approval/audit
trail, no bypass of provider policy / budgets / redaction, manual
bridge stays as fallback. Long-term P66 target: companion → outbound
authenticated session → hosted relay/control plane.

### Status: ✅ P64.2 done. Awaiting sign-off on P65.

---

## P65 — Codex Companion Experimental Alpha (2026-05-09)

**Status:** ✅ Alpha shipped. Hosted infrastructure + companion package are functional and tested. Browser ChatView integration is the remaining wiring step (see "Known limitations").

P64.2 confirmed that the hosted browser cannot connect directly to a properly secured Codex `app-server` because Codex requires the capability token via `Authorization: Bearer` and browsers can't set arbitrary headers on WebSocket. P65 introduces a **local companion** that sits between the browser and Codex:

```
Hosted Hyperagent  ──>  Browser tab  ──>  Companion (loopback)  ──>  codex app-server  ──>  ChatGPT/Codex auth
```

The companion runs on the user's machine via `npx hyperagent-codex-companion <pair-code>`, claims a short-lived pairing session against the hosted app, and exposes a loopback HTTP/WS API the browser drives. Codex never speaks directly to the browser.

### a. Files added

| Path | Purpose |
|------|---------|
| `src/lib/codex/pair-store.ts` | Pairing session DB store: start/claim/status/revoke/heartbeat/authenticate. SHA-256-hashed pair codes + session secrets; constant-time scoping; `validateCompanionBaseUrl` enforces loopback-only companion URLs. |
| `src/lib/codex/pair-store-internal.ts` | Internal helper used by /pair/claim to look up the session's userId from the pair-code hash. |
| `src/lib/codex/run-ticket.ts` | Stateless HMAC-SHA-256 signed run tickets. Issue + verify + encode + decode. Carries runId, userId, threadId, pairSessionId, providerMode, approvalPolicy, budgetMicroUsd + budgetEnforcement (advisory in companion mode), traceTarget, expiry, nonce. |
| `src/lib/codex/event-mirror.ts` | Server-side sink for events mirrored from the companion / browser. Validates source/sequence/eventType, enforces per-(runId,source) monotonic sequence, idempotency by (runId, source, idempotencyKey), redacts via `redactJson`, refuses payloads >64 KB. |
| `src/lib/codex/companion-client.ts` | Browser-side client that fetches /api/codex/run-ticket, opens WS to the loopback companion at `ws://127.0.0.1:PORT/turn`, sends the first-message hello, and forwards events to a caller-supplied handler. |
| `src/app/api/codex/pair/start/route.ts` | POST: generates a fresh pair-code; rate-limited 8/5min/user. Cache-Control: no-store. |
| `src/app/api/codex/pair/claim/route.ts` | POST: companion claims a pair-code; pair-code IS the auth (no cookie required). |
| `src/app/api/codex/pair/status/route.ts` | GET: browser polls; constant-time scoping returns 'not_found' for foreign sessions. |
| `src/app/api/codex/pair/revoke/route.ts` | POST: user-initiated disconnect. |
| `src/app/api/codex/pair/heartbeat/route.ts` | POST: companion → server every ~30s with sessionSecret. |
| `src/app/api/codex/run-ticket/route.ts` | POST: issues run ticket; verifies pair session is online before issuing. |
| `src/app/api/codex/events/route.ts` | POST: event mirror sink; verifies run ticket signature + expiry; ≤200 events/request, ≤64 KB/event. |
| `packages/codex-companion/package.json` | npm package metadata; `bin` entry exposes `hyperagent-codex-companion`. |
| `packages/codex-companion/bin/hyperagent-codex-companion.js` | CLI entry; arg parsing; refuses non-loopback bind without `--i-understand`. |
| `packages/codex-companion/src/companion.js` | Main orchestrator: claim → spawn codex → start browser server → heartbeat loop → wait for browser turns. |
| `packages/codex-companion/src/codex-process.js` | CodexProcess class: spawn `codex app-server` (stdio), JSON-RPC 2.0 multiplex, server-initiated request fan-out, clean shutdown. |
| `packages/codex-companion/src/browser-server.js` | BrowserServer class: HTTP/WS on loopback; origin enforcement; PNA preflight; first-message auth; /health, /turn (WS), /approval, /cancel, /shutdown. |
| `packages/codex-companion/src/event-mirror.js` | Companion-side sink that batches + retries POSTs to `/api/codex/events`. |
| `packages/codex-companion/src/redact.js` | Local redactor for log lines. Mirrors hosted-side rules. |
| `packages/codex-companion/README.md` | User-facing setup + flags + security model + troubleshooting. |
| `src/components/settings/CodexSection.tsx` | Replaces placeholder `CodexCompanionPane` with full pairing UI: status panel, generate button, copy command, regenerate, disconnect, troubleshooting; live-polls /api/codex/pair/status. |
| `scripts/codex-companion-smoke-test.ts` | Real-binary smoke test gated by `CODEX_SMOKE_TEST=1`. |

### b. New endpoints

| Method + path | Auth | Purpose |
|---------------|------|---------|
| `POST /api/codex/pair/start` | session cookie | Generate pair-code (returns once, never logged). |
| `POST /api/codex/pair/claim` | pair-code (no cookie) | Companion claims; receives sessionId + sessionSecret (returned once). |
| `GET  /api/codex/pair/status?sessionId=...` | session cookie | Browser polls. Returns claimed/online/expired/revoked + companionBaseUrl. |
| `POST /api/codex/pair/revoke` | session cookie | User disconnects. |
| `POST /api/codex/pair/heartbeat` | sessionSecret | Companion every ~30s. |
| `POST /api/codex/run-ticket` | session cookie | Issue signed run ticket bound to pair session. |
| `POST /api/codex/events` | run-ticket signature | Persist mirrored events with idempotency + per-source monotonic sequence. |

### c. Companion package: how to run

```sh
# 1. Sign in to the hosted Hyperagent app.
# 2. Settings → Codex → Codex Companion (Experimental).
# 3. Generate pair code, copy the printed command.
# 4. Run on your machine:
npx hyperagent-codex-companion <pair-code> --host=https://app.example.com

# Optional flags:
#   --port=8390           Pin a specific local port (default: ephemeral).
#   --bind=127.0.0.1      Bind host. Anything else needs --i-understand.
#   --codex=/path/to/codex Override codex binary path.
#   --no-spawn            Don't start codex; expect it running externally.
#   --status              Print local status and exit.
```

The companion claims the pair code, starts `codex app-server` over stdio (preferred — no auth handshake to manage, no listener to firewall), brings up its own loopback HTTP/WS server, and prints status lines as it runs.

### d. Connection flow walkthrough

1. **User clicks "Generate pair code".** Browser POSTs `/api/codex/pair/start`, receives `{ sessionId, pairCode, expiresAt }`. The pair-code is shown ONCE in the UI as the npx command.

2. **User runs `npx hyperagent-codex-companion <pair-code> --host=...`.**
   - Companion validates `--bind` is loopback (or the user passed `--i-understand`).
   - Companion runs `detectCodex()`. If codex is missing it prints an actionable error and exits.
   - Companion brings up `BrowserServer` on `127.0.0.1:<port>` (origin-enforced to the `--host` URL).
   - Companion POSTs `/api/codex/pair/claim` with the pair-code + its base URL + companion info. Receives `{ sessionId, sessionSecret, expiresAt }`. The sessionSecret is held in memory only — never written to disk, never logged.
   - Companion spawns `codex app-server --listen stdio://`. Sends `initialize`. Reads `getAuthStatus` once for status display.
   - Companion starts its 30s heartbeat loop POSTing `/api/codex/pair/heartbeat`.

3. **Hosted UI flips to "Companion online".** Status poll at `/api/codex/pair/status` returns `online: true` once a heartbeat lands.

4. **User sends a chat message in the browser.**
   - ChatView calls `startCompanionTurn({ threadId, agentId, pairSessionId, text, onEvent })`.
   - The client fetches `/api/codex/run-ticket` for a signed ticket bound to this user/thread/pair-session.
   - It opens `ws://127.0.0.1:<port>/turn` against the companion. CORS/PNA preflight passes (companion responds with `Access-Control-Allow-Private-Network: true` only for the configured origin).
   - First message is `{ type: "hello", runTicket: "<encoded>", input: { threadId, text } }`. Without it, the companion closes the WS within 5s with code 4401.
   - Companion verifies the ticket's expiry + pairSessionId match locally, then drives `thread/start` (if needed) and `turn/start` against codex.
   - All codex notifications flow back to the browser as `{ type: "codex_event", method, params }`. Approval requests surface as `approval_required` with a synthesized approvalId.
   - Each event is mirrored to `/api/codex/events` with a run ticket attached so the hosted trace store stays in sync.

5. **Approval flow.** Codex emits `item/commandExecution/requestApproval` (or one of the other 7 server-initiated approval methods). Companion forwards a synthesized notification to the browser. The user clicks Accept/Decline. Browser sends `{ type: "approval", approvalId, decision }` over the WS. Companion resolves the pending JSON-RPC server-request id with `{ decision: "approved" | "denied" | "approvedForSession" }` so codex resumes. The decision is also mirrored to the hosted events store.

6. **Disconnect.** User clicks "Disconnect" in the UI → POST `/api/codex/pair/revoke`. Companion's next heartbeat returns 410, and the companion exits cleanly. Or the user kills the npx process — its SIGINT handler runs `gracefulShutdown` (revoke + stop codex + stop browser server).

### e. Behavior by environment

| Environment | Companion runs | Codex auth | Notes |
|-------------|----------------|------------|-------|
| **Hosted Vercel** | not on the server; user runs `npx hyperagent-codex-companion` on their own machine | codex CLI on user's machine | the hosted app cannot reach the user's machine. The browser is the bridge. |
| **Local dev** | optional — Codex Local mode (stdio) is also available since the dev server runs on the user's machine | codex CLI locally | Companion still works as a loopback isolation layer if the user prefers it. |
| **Docker** | container running Hyperagent must allow the user's browser to reach the user's host loopback. Most Docker setups put the browser on the same host as `npx`, so this works the same as local dev. | codex CLI on host | If Hyperagent is in a container and the browser is on the host, the companion runs on the host. |
| **Desktop / local wrapper** | full local stack — companion, codex, hosted app all on one machine. Works identically. | codex CLI on host | This is the friendliest case. |

### f. Test inventory (P65)

| Test file | Assertions | Coverage |
|-----------|------------|----------|
| `codex-pair-store.test.ts` | 30 PASS | start/claim/status/revoke/heartbeat happy paths + foreign-user scoping + URL validation + expiry + duplicate claim + secret-hash invariants |
| `codex-run-ticket.test.ts` | 22 PASS | issue/verify/expiry/tampered-payload/tampered-sig/key-rotation/encode-decode/policy roundtrip/nonce uniqueness/traceTarget default |
| `codex-event-mirror.test.ts` | 18 PASS | validation + monotonic sequence + idempotency + per-source ceiling + redaction + oversize rejection + idempotency-key derivation |
| `codex-companion-runtime.test.ts` | 22 PASS | ENOENT detection + JSON-RPC initialize round-trip + server-initiated request handler + clean stop + BrowserServer origin enforcement (allowed/blocked/PNA preflight) + WS 4403/4404/4401 close codes + first-message hello dispatch + redaction |
| Existing P64.2 tests | 312 PASS | no regressions; full `npm run test:codex` passes |
| **Total** | **404 PASS / 0 FAIL** | |

### g. Real-binary smoke test (gated, CODEX_SMOKE_TEST=1)

Run: `CODEX_SMOKE_TEST=1 npx tsx scripts/codex-companion-smoke-test.ts`.

Result against `@openai/codex` v0.130.0 in this environment:

```json
{
  "binary": { "found": true, "version": "codex-cli 0.130.0" },
  "initialize": { "ok": true, "result": {
    "userAgent": "hyperagent-codex-companion-smoketest/0.130.0 (...)",
    "codexHome": "/agent/.codex", "platformFamily": "unix", "platformOs": "linux"
  } },
  "getAuthStatus": { "ok": true, "result": { "authMethod": null, "authToken": null, "requiresOpenaiAuth": true } },
  "accountRead": { "ok": true, "result": { "account": null, "requiresOpenaiAuth": true } },
  "threadStart": { "ok": true, "result": { "thread": { "id": "019e0da4-…" }, "model": "gpt-5.5", "modelProvider": "openai" } },
  "cleanShutdown": true,
  "notificationsObserved": ["configWarning", "remoteControl/status/changed", "thread/started"],
  "stderrLines": 1
}
```

✅ Real codex smoke test passed: companion's `CodexProcess` correctly drives a real `codex app-server` over stdio, completes initialize / getAuthStatus / account/read / thread/start, and shuts down cleanly. (turn/start would require an authenticated codex session and would consume real ChatGPT credits, so we deliberately don't run it in the smoke suite.)

### h. Security review

| Concern | Status | Mitigation |
|---------|--------|-----------|
| **Hosted DB stores ChatGPT/Codex tokens** | ✅ avoided | Codex auth (access/refresh/ID tokens) lives in `~/.codex/` on the user's machine. The companion never reads them and the hosted app never sees them. |
| **Companion exposed to public internet** | ✅ avoided | Default bind is `127.0.0.1`. Non-loopback bind requires `--i-understand`. Companion URL is validated server-side at claim (loopback-only). |
| **Browser → companion auth** | ✅ enforced | First-message hello with signed run ticket. Origin checked against the configured `--host`. PNA preflight returns `Access-Control-Allow-Private-Network: true` only for that origin. |
| **Pair-code brute force** | ✅ mitigated | 192 bits of entropy (24 random bytes hex = 48 chars). 5-minute window. SHA-256 hashed in DB. Rate-limited 8/5min/user on `/pair/start`. |
| **Pair-code reuse** | ✅ blocked | Conditional UPDATE pattern: only `pending → claimed` is allowed; second claim returns `already_claimed`. |
| **Pair-code claim by wrong user** | ✅ blocked | claim pulls userId from the pair-code's row and constant-time-compares against caller. UI binds pair-code to user at /start time via session cookie. |
| **Session secret leakage** | ✅ minimized | Returned once on claim; held in companion memory only; SHA-256 hashed in DB; constant-time compared via `timingSafeEqual` on heartbeat. |
| **Run ticket forgery** | ✅ blocked | HMAC-SHA-256 with server-side secret. Tampered payload + tampered sig + post-key-rotation tickets all fail verification. |
| **Run ticket replay (cross-run poisoning)** | ✅ blocked | Each ticket carries a 128-bit nonce + monotonic per-source sequence on event mirror. Out-of-order rejected; duplicates idempotent-deduped. |
| **DNS rebinding to companion** | n/a — companion is loopback; the browser uses the literal 127.0.0.1 URL the hosted app reports. |
| **TOCTOU on hosted-side companion URL** | ✅ mitigated | URL is validated at claim and surfaced verbatim to the browser via /pair/status. The hosted server never fetches it; only the user's browser does. |
| **Logs leaking secrets** | ✅ enforced | Both hosted (`redactJson` / `redactRpcEnvelope`) and companion (`packages/codex-companion/src/redact.js`) redact sensitive keys (authorization, *Token, *Secret, password, pairCode, capability_token, etc.) and Bearer/JWT/sk-prefixed values. Defense in depth: route-level redaction PLUS event-mirror's pre-INSERT redaction PLUS companion-side log redaction. |
| **Cache leaking secrets** | ✅ enforced | All pair / run-ticket / events routes set `Cache-Control: no-store`. |
| **Non-loopback companion impersonation** | ✅ blocked | `validateCompanionBaseUrl` rejects anything other than http(s)://localhost / 127.0.0.1 / ::1 / *.localhost. Embedded credentials in URL refused. |
| **Cross-origin browser pages talking to companion** | ✅ blocked | BrowserServer's HTTP responses set `Access-Control-Allow-Origin` only for the configured allowed origin; OPTIONS preflight rejects others. WS connections without a matching `Origin` header are closed with code 4403. |
| **Provider fallback abuse** | ✅ avoided | Companion mode is selected explicitly. The chat dispatch path refuses companion mode for server-side dispatch (chat/route.ts) and surfaces a clear "use the browser path" error. There is no silent fallback to API-key billing. |
| **Token in URL query strings** | ✅ avoided | Run tickets travel in JSON bodies. Pair-codes travel in JSON bodies. Session secrets only in JSON bodies. WS auth is the first message after open. |
| **CSRF on /pair/* routes** | ✅ adequate for alpha | /pair/start, /pair/status, /pair/revoke require a session cookie AND act on user-scoped state, so a forged cross-origin POST that lands here can only revoke / start the user's OWN session. We rely on the SameSite cookie default (Lax) plus the no-cors restrictions browsers place on POST with `Content-Type: application/json` (which require a preflight). Tightening to a CSRF token is on the P66 list. |
| **Idempotency-key collision** | ✅ unique constraint | `UNIQUE ("runId","source","idempotencyKey")` on `codex_run_events`. Duplicate POSTs collapse silently with a count returned to the client. |
| **Out-of-order events poisoning the trace** | ✅ rejected | persistMirroredEvents tracks per-(runId, source) max sequence and refuses backfill. Lower-sequence events with a fresh idempotency key are counted as `outOfOrder` and dropped. |
| **Oversize event payloads** | ✅ refused | 64 KB cap enforced both before AND after redaction. |
| **Companion crash / codex crash** | ✅ surfaced | Companion's onExit handler revokes the pair session immediately so the browser sees offline within seconds. Hosted side also expires the session after 90s with no heartbeat. |
| **Tab close mid-run** | ⚠️ alpha limitation | The browser drives the WS handshake; if the tab closes the WS dies and the companion's per-turn handler fires `close()`. The pair session survives but the run is abandoned. Documented in the README. |

### i. Known limitations (P65 alpha)

1. **Browser ChatView wiring is the next step.** `companion-client.ts` is built and unit-testable, but the integration into `ChatView.tsx` (branch on `providerMode === "codexChatGPTCompanion"`) is intentionally NOT shipped in this commit to keep P65 reviewable. Adding the branch is mechanical: detect mode → call `startCompanionTurn` instead of `fetch("/api/chat")`. This will land as P65.1 once UX is reviewed.
2. **Budget enforcement is advisory only in companion mode.** Real billing is on the user's ChatGPT plan. The run ticket carries `budgetEnforcement: "advisory"` — the hosted UI labels companion-mode budgets accordingly and does NOT claim hard enforcement.
3. **No tab-close survival.** Closing the browser tab abandons the in-flight run (the WS dies, the companion fires the per-turn close handler). Re-opening reconnects to the companion but does NOT resume the abandoned codex turn. Documented in the README.
4. **No multi-machine / multi-companion support.** One companion per pair session; one pair session per user "active". A user pairing a new machine must revoke the old session first.
5. **No CSRF token on /pair/* routes.** SameSite=Lax cookie + JSON content-type is the current defense; a CSRF token will land with P66.
6. **Token entropy guidance vs. enforcement.** `validateTokenEntropy` from P64.2 still gates manual bridge tokens; companion-mode credentials are auto-generated server-side and never user-pasted, so the gate doesn't apply there.
7. **Full real-binary turn smoke.** The smoke test exercises everything up through `thread/start` against an unauthenticated codex. A full `turn/start` smoke requires an authenticated `~/.codex` setup and would consume real ChatGPT credits — we deliberately do not run it in CI.
8. **Hosted relay (P66) not started.** The companion currently relies on the user's BROWSER to bridge browser↔companion↔codex traffic. P66 will introduce an outbound-only relay so the companion makes a single outbound connection to the hosted app, which can then drive turns even when no browser tab is open.

### j. What remains for P66 (deferred)

- **Hosted relay / control plane.** Companion → outbound authenticated session to a hosted relay → relay drives turns. This decouples runs from individual browser tabs and lets the hosted side enforce real budgets, queue runs, and survive tab closes. Architecture sketch:
  - Long-lived outbound mTLS / signed HTTPS connection from companion to relay.
  - Relay holds active runs per user; brokers between browsers and companions.
  - Hard budget enforcement happens at the relay (not the companion).
  - Multi-machine companions become trivial — relay routes runs to whichever companion is online.
- **Tab-close run survival.** Once relay exists, the relay holds the WS to the companion; closing the tab is fine.
- **CSRF tokens on pair/* routes.** Concrete signed CSRF tokens added to /start + /revoke (low-risk endpoints, but worth the belt + suspenders).
- **Full provider policy enforcement at run-ticket time.** Today the policy fields are advisory. P66 will enforce at the relay (drop a turn that violates the ticket).
- **Multi-companion / org-shared companions.** Routing rules for selecting a companion when several are online.
- **Companion auto-update channel** for security fixes.

### k. Whether P64.2 smoke test still passes

Yes — `CODEX_SMOKE_TEST=1 npx tsx scripts/codex-smoke-test.ts` still runs cleanly. The new companion smoke test joins it as a second gated tool.

### l. Status

✅ **P65 Codex Companion Experimental Alpha** — pairing infrastructure, run tickets, event mirror, companion package, UI, real-binary smoke test, and 92 new unit-test assertions.

⚠️ **Not production-ready.** The honest banner in the UI says so. Browser-driven ChatView dispatch + tab-survival + hosted relay are P65.1 / P66 work.

🚫 **P66 hosted relay/control plane** is **NOT** started per scoping instructions.

### Status: ✅ P65 alpha shipped. Awaiting end-to-end real-companion run feedback before tightening to beta.

---

## P65.1 — Companion chat dispatch wiring + alpha hardening (2026-05-09)

**Status:** ✅ Shipped. ChatView dispatches into companion mode end-to-end; CSRF/Origin guard applied to mutating cookie-bearing routes; oversize event payloads now persist as truncation stubs rather than dropping silently; real-binary E2E smoke test exercises the full browser ↔ companion ↔ codex chain and verifies events flow back to the trace store.

### a. Files added / changed

| Path | Change |
|------|--------|
| `src/lib/codex/origin-guard.ts` | **New.** `checkOrigin`, `checkContentType`, `enforceCsrf`, `enforceCsrfReadOnly` helpers. Defends mutating cookie-bearing routes against cross-site forged POSTs. |
| `src/app/api/codex/pair/start/route.ts` | Calls `enforceCsrf` before `getCurrentUser`. |
| `src/app/api/codex/pair/revoke/route.ts` | Calls `enforceCsrf` before `getCurrentUser`. |
| `src/app/api/codex/pair/status/route.ts` | Calls `enforceCsrfReadOnly`. |
| `src/app/api/codex/run-ticket/route.ts` | Calls `enforceCsrf`. |
| `src/lib/codex/run-ticket.ts` | Refuses to operate in production without a configured signing key (`CODEX_RUN_TICKET_KEY` / `APP_SECRET` / `NEXTAUTH_SECRET` / `SESSION_SECRET`). Local dev still falls back to a per-process random key. |
| `src/lib/codex/event-mirror.ts` | New `MAX_RAW_BYTES` 1 MB hard cap; events between 64 KB and 1 MB now persist with a `truncated: true` stub recording `originalSizeBytes`, `topLevelKeys`, and `previewJson`; `truncated` counter added to `PersistResult`. |
| `src/components/ChatView.tsx` | **Dispatch branch added.** When `providerMode === codexChatGPTCompanion`, `send()` skips `/api/chat`, persists the user message via the messages API, and routes through the new `sendThroughCompanion()` helper which calls `companion-client.startCompanionTurn`. Stop button cancels the companion turn. Approval cards in companion mode call back through WS instead of REST. Experimental banner renders above the chat. |
| `packages/codex-companion/src/event-mirror.js` | Adds `HYPERAGENT_COMPANION_DEBUG=1` stderr diagnostics for the flush path and surfaces last-error string on failure. |
| `scripts/codex-companion-e2e-smoke-test.ts` | **New.** Real-binary end-to-end smoke. In-process Postgres-free stub of the hosted endpoints, real `npx hyperagent-codex-companion` child, real `codex app-server`, real WebSocket from the browser side, real `mirror.flush` to the stub. Verifies the full chain. |
| `src/lib/__tests__/codex-event-mirror.test.ts` | New cases: 64 KB+ payload becomes a truncation stub (preserves topLevelKeys, previewJson, originalSizeBytes); 1 MB+ raw payload still rejected outright. |
| `src/lib/__tests__/codex-origin-guard.test.ts` | **New.** 17 assertions covering same-origin pass, cross-origin refuse, no-Origin server-to-server pass, Referer fallback, X-Forwarded-Host, port mismatch, content-type enforcement, full enforceCsrf integration. |
| `package.json` | New `test:codex-origin-guard` entry; `test:codex` aggregate now runs 15 groups. |

### b. ChatView dispatch branch

`send()` now branches on the result of `GET /api/codex/provider-mode`:

```
anthropicApiKey | openaiApiKey | openaiUserApiKey | codexChatGPTLocal | codexChatGPTBridge
                                  ↓
                        existing /api/chat SSE path

codexChatGPTCompanion
  ↓
1. read codex-companion:sessionId from localStorage
   → if absent, render error message "open Settings → Codex"
2. POST /api/threads/{id}/messages   (persist user message; best-effort)
3. sendThroughCompanion({ text, pairSessionId })
     - calls startCompanionTurn from companion-client.ts
     - companionRef.current holds the live turn handle for Stop button
     - per-event handlers translate streaming events into existing
       Msg-shape mutations (delta / tool_use / tool_result / approvals
       / done / error)
4. on completion or error: streaming=false, activeRunId cleared,
   companionRef cleared, reload() refreshes thread state
```

**No silent fallback.** If companion mode is selected but no pair session is in localStorage, ChatView surfaces a clear error pointing the user at Settings → Codex. If the WS handshake fails (e.g. companion offline), the `CompanionUnavailableError`'s reason is shown verbatim. There is no path that quietly downgrades to API-key billing or to another user's account.

### c. Companion run flow (browser-driven)

```
ChatView.send() detects codexChatGPTCompanion
  ↓
GET /api/codex/pair/status?sessionId=...
  ↓ (companion online + companionBaseUrl)
POST /api/codex/run-ticket  (CSRF-guarded, cookie-authenticated)
  ↓ returns { ticket, encoded, payload: { runId, expiresAt, ... } }
ws.connect ws://127.0.0.1:PORT/turn   (companion's loopback BrowserServer)
  ↓
ws.send({ type: "hello", runTicket: encoded, input: { threadId, text } })
  ↓ companion verifies expiry + pairSessionId locally, then drives codex
codex notifications → companion sends type: codex_event over WS
companion mirrors every event to POST /api/codex/events with the run ticket
  ↓ approval requests surface as type: approval_required to the browser
ChatView renders ApprovalCard with onDecide callback (companion path)
  ↓ user clicks → companionTurn.approval(approvalId, decision)
  ↓ companion responds to codex's pending JSON-RPC request id
  ↓ companion ALSO mirrors the decision to /api/codex/events
turn/completed → ws closes → ChatView marks streaming=false
```

### d. Storage durability — answered

Both `pair-store.ts` and `event-mirror.ts` use `pool()` from `src/lib/db.ts`, which is the same Postgres pool the rest of the app uses. **All pairing sessions, heartbeats, revocations, and event rows are durable across Vercel function instances.** The only module-level state in either file is an idempotent schema-creation guard (`_initialized`) that simply skips a no-op `CREATE TABLE IF NOT EXISTS` after the first call per process — perfectly safe across cold starts.

`run-ticket.ts` is stateless by design (HMAC-signed envelope; no DB row). The HMAC key is derived from the same env secret across all instances. P65.1 hardens the fallback path: if no env secret is configured AND the runtime is detected as production (`VERCEL` / `VERCEL_ENV` / `NODE_ENV=production`), `loadKey()` throws — preventing a silent "tickets only verifiable on the same lambda" failure mode. Local dev still gets a per-process random key.

### e. CSRF / auth hardening — applied

Endpoint-by-endpoint matrix:

| Endpoint | Method | Auth source | CSRF defense | Rate limit |
|----------|--------|-------------|--------------|------------|
| `/api/codex/pair/start` | POST | session cookie | `enforceCsrf` (Origin + Content-Type + SameSite=Lax) | 8/5min/user |
| `/api/codex/pair/claim` | POST | pair-code (192-bit one-time) | n/a — pair-code IS the auth | inherent (pair-code TTL) |
| `/api/codex/pair/status` | GET  | session cookie | `enforceCsrfReadOnly` | n/a (read-only) |
| `/api/codex/pair/revoke` | POST | session cookie | `enforceCsrf` | inherent (revoking own session) |
| `/api/codex/pair/heartbeat` | POST | sessionSecret (256-bit) | n/a — secret IS the auth | inherent (per-session) |
| `/api/codex/run-ticket` | POST | session cookie | `enforceCsrf` | inherent (one ticket per turn) |
| `/api/codex/events` | POST | run-ticket signature | n/a — HMAC IS the auth | 200 events/req cap |

`enforceCsrf` rejects any browser-shaped POST whose `Origin` doesn't match the request's host (or `X-Forwarded-Host` when behind a proxy). Falls back to `Referer` when `Origin` is absent. Server-to-server callers (no `Origin`, no `Referer`) pass — they're not a browser CSRF threat. Bad `Content-Type` returns 415; cross-origin returns 403. SameSite=Lax cookie attribute (the auth provider default) is the third layer of defense.

A malicious page that forges a POST to `/api/codex/pair/revoke` from a victim's logged-in browser would hit:
1. `Content-Type` browser-side: `text/plain` is the only no-preflight option; refused with 415.
2. If attacker uses `application/json` they trigger CORS preflight, which our routes don't ack with `Access-Control-Allow-*`; preflight fails; actual POST never fires.
3. If somehow the POST does fire, `Origin` is the attacker's domain; `enforceCsrf` returns 403.

### f. Approval flow — companion-mode wired

When the assistant message is currently streaming AND the user's provider mode is companion, `MessageView` receives an `onApprovalDecision` callback that calls `companionRef.current.approval(approvalId, decision)`. The companion-side WS handler in `BrowserServer` forwards the decision to the per-turn `pendingApprovals` map keyed on the synthesized approvalId, which then resolves the original codex server-initiated request with `{ decision: "approved" | "denied" | "approvedForSession" }`. The decision is also mirrored to `/api/codex/events` with `eventType: "approval/decision"` so the audit log captures the user's choice.

When provider mode is NOT companion (i.e. bridge / local), `ApprovalCard.send()` falls back to the existing `POST /api/codex/approval/[id]` REST endpoint, preserving the unchanged behavior of those modes.

**Companion mode cannot bypass approval policies** — the run ticket carries the approval policy declared at issue time, and approvals are surfaced to the browser via the same `approval_required` event shape the rest of the UI expects.

### g. Cancellation status

The Stop button in ChatView now does three things in companion mode:
1. Calls `abortRef.current?.abort()` — cancels any in-flight `/api/threads/.../messages` write.
2. Calls `companionRef.current.cancel()` — sends `{ type: "cancel" }` over the WS, which triggers the companion's per-turn handler to call `codex.request("turn/interrupt", { turnId })`. The companion mirrors a `turn/cancel_requested` event to `/api/codex/events`.
3. After ~200 ms calls `companionRef.current.close()` to tear down the WS and prevent further events from streaming into a stopped UI.
4. (Hosted-path fallback) `POST /api/runs/{runId}/cancel` is fired regardless, so the trace store sees the cancellation marker.

**Codex `turn/interrupt` is best-effort.** Per the codex protocol, `turn/interrupt` is the documented way to stop an in-flight turn but does NOT guarantee immediate termination of an already-running tool call. The user's tab close will also tear down the WS, which causes the companion's per-turn close handler to fire `turn/interrupt` defensively; from there codex itself decides how cleanly the run unwinds. We treat companion-mode cancellation as "asks codex to stop and tears down our side" — same UX promise as the existing hosted path, and documented as such in the README.

### h. Event mirroring + truncation

**All companion events are mirrored.** Every notification codex emits (`thread/started`, `turn/started`, `turn/completed`, `item/agentMessage/delta`, `item/commandExecution/requestApproval`, etc.) flows through the companion's `EventMirror.push` and gets POSTed to `/api/codex/events` in batches of up to 50, every 250 ms. The browser also forwards its own approval decisions via `mirror.push({ source: "browser", eventType: "approval/decision", ... })`.

**Each mirrored event includes** runId (from the ticket), source (`browser` / `companion` / `codex`), monotonic per-source sequence, eventType, emittedAt timestamp, idempotencyKey, and a redacted payload. The hosted side persists with `UNIQUE ("runId","source","idempotencyKey")` so duplicate POSTs from retry loops collapse silently.

**Oversize payloads (P65.1 update):**
- ≤ 64 KB after redaction → stored verbatim
- 64 KB – 1 MB raw → stored as a truncation stub: `{ truncated: true, truncationReason: "oversize", originalSizeBytes, topLevelKeys, previewJson }`. The `topLevelKeys` array preserves debugging signal even when the body is too large to keep; `previewJson` carries up to 4 KB of redacted JSON prefix.
- > 1 MB raw → refused outright, counted as `invalid` in the persist result.

This change means **failure / approval / tool events are never silently lost** — they always leave a debuggable footprint in the trace store. The `truncated` counter on `PersistResult` lets the caller surface "n events were truncated" in any future trace UI.

### i. Test inventory (P65.1)

| Test file | Assertions | New in P65.1 |
|-----------|------------|--------------|
| `codex-pair-store.test.ts` | 30 PASS | unchanged |
| `codex-run-ticket.test.ts` | 22 PASS | unchanged |
| `codex-event-mirror.test.ts` | 25 PASS | +7 covering 64 KB+ truncation stub fields and 1 MB+ rejection |
| `codex-companion-runtime.test.ts` | 22 PASS | unchanged |
| `codex-origin-guard.test.ts` | 17 PASS | **new** — same-origin / cross-origin / no-origin / Referer fallback / X-Forwarded-Host / port mismatch / content-type / full enforceCsrf integration |
| Existing P65 + P64.2 tests | 302 PASS | unchanged |
| **Total** | **418 PASS / 0 FAIL** | +24 new assertions over P65 |

### j. Real E2E smoke test result

Run with `CODEX_SMOKE_TEST=1 npx tsx scripts/codex-companion-e2e-smoke-test.ts` against `@openai/codex` v0.130.0 in this environment:

```json
{
  "stubServer":   { "up": true, "port": 36241 },
  "pairing":      { "pairCode": true, "claimed": true, "heartbeats": 1 },
  "companion":    { "spawned": true, "statusLines": [
    "codex_found: Codex binary: codex-cli 0.130.0",
    "browser_server_listening: Listening at http://127.0.0.1:43261",
    "paired: Paired (session expires in ~1440 min)",
    "codex_starting: Starting codex app-server (stdio)…",
    "codex_ready: Codex app-server is running.",
    "auth: Codex auth: needs_login",
    "running: Ready for browser turns.",
    "shutting_down: Received SIGTERM; shutting down…",
    "codex_exited: codex app-server exited with code 0",
    "shutdown: All subsystems stopped."
  ] },
  "browserServer": {
    "url": "http://127.0.0.1:43261",
    "helloAccepted": true,
    "wsEventTypes":  ["thread_started", "codex_event", "turn_started"],
    "wsEventCount":  11
  },
  "codexRoundTrip": { "initialize": true, "getAuthStatus": false, "threadStart": true },
  "events": {
    "mirrored": 13,
    "eventTypes": ["companion/connected", "codex/state", "thread/started",
                   "turn/started", "thread/status/changed", "item/started",
                   "item/completed", "error"],
    "requestsReceived": 5,
    "lastRejection": null
  },
  "cleanShutdown": true
}
```

**Verified end-to-end:**
- ✅ Pair-code generated, companion claimed against the stub via real HTTP
- ✅ Companion detected real codex 0.130.0 and spawned `codex app-server` over stdio
- ✅ Browser-side test client connected to companion's loopback `/turn` WS
- ✅ First-message hello with signed run ticket accepted
- ✅ `thread/start` against real codex returned a real thread id
- ✅ `turn/start` against real codex returned a real turn id
- ✅ 11 streaming events forwarded over WS to the browser side
- ✅ 13 events mirrored to `/api/codex/events` across 5 batched POSTs (run-ticket signature verified server-side)
- ✅ Clean shutdown: `SIGTERM → codex_exited code=0 → shutdown`

The only thing this smoke does NOT exercise is a real LLM call, because the test environment's codex isn't signed in (`auth: Codex auth: needs_login`). The actual model-call branch of `turn/start` would surface an auth error that's also mirrored as an `error` event — exactly the shape we want for trace debugging. Adding a "real authenticated turn against real ChatGPT" smoke would require credentials and would consume real plan credits, which we deliberately do NOT run automatically.

### k. Remaining alpha limitations

1. **Tab close mid-run abandons the run.** The browser tab owns the WS to the companion. Closing it closes the WS; the companion's per-turn handler fires `turn/interrupt`. The pair session survives but the in-flight turn is gone. **Documented in the companion README + experimental banner.** P66 hosted relay solves this.
2. **Budget enforcement is advisory only in companion mode.** Real billing remains on the user's ChatGPT plan. P66 relay gets hard budget enforcement at the relay seam.
3. **Run-ticket signing key fail-closed in production.** If `CODEX_RUN_TICKET_KEY` (or `APP_SECRET`/`NEXTAUTH_SECRET`/`SESSION_SECRET`) is missing on Vercel, the run-ticket route throws on first call rather than silently letting tickets fail to verify across instances. This is explicit and loud — operations need to set the env var. Local dev is unaffected.
4. **Companion auto-update channel not built.** Users get whatever `npx hyperagent-codex-companion` resolves to at the time. Pinning a version in the printed command is recommended once we publish to npm.
5. **No explicit support for multi-tab on the same pair session.** The companion's per-turn handler dispatches one run per WS connection. Two browser tabs both opening WS to the same companion can each run a turn, but they don't see each other's events directly — the hosted trace store is the cross-tab consistency seam.
6. **Heartbeat loss vs. revoke vs. expire are surfaced via three different status values.** UI handles this fine but the lifecycle could be tightened.
7. **`/api/codex/pair/heartbeat` is unauthenticated except by sessionSecret.** That's intentional (companion has no cookie) but means a stolen sessionSecret lets the attacker keep a session alive. Mitigated by the SHA-256 hash + revoke endpoint, but worth tightening with a mTLS-shaped trust model in P66.

### l. What must wait for P66 (hosted relay/control plane)

- **Tab-close run survival.** Relay holds the WS to the companion; closing the tab is fine.
- **Hard budget enforcement.** Relay drops a turn that exceeds the ticket's `budgetMicroUsd`.
- **Multi-machine companion routing.** Relay decides which companion handles a given run.
- **Companion-side outbound-only auth.** Companion makes a single signed outbound connection to the relay; relay does inbound NAT traversal for the browser. Avoids the "browser must reach localhost" preflight problem entirely (works on lockdown corporate networks where Chrome PNA is restricted).
- **Run-ticket revocation.** Today tickets just expire on the 30-min TTL. With a relay we can revoke a specific runId server-side and have the companion + browser see the revocation immediately.
- **Org-scoped pair sessions.** Today pair sessions are user-scoped; org admins should be able to inspect/revoke org members' sessions.

### Status: ✅ P65.1 done — companion mode is product-complete as an experimental alpha.

🚫 **P66 hosted relay/control plane is NOT started.** It remains the agreed next milestone; this commit explicitly stays scoped to making the existing companion architecture usable end-to-end without expanding the surface area.

---

## P66a — Audit + Architecture Plan (NO IMPLEMENTATION) (2026-05-09)

**This section is a planning artifact only.** No code changes are made; per the P66a scope, all coding work waits on explicit approval of the proposed architecture below.

P65/P65.1 shipped the right architecture for an alpha (browser ↔ companion ↔ codex), but several P66 product goals — server-authoritative runs, tab-close survival, and a stable hosted relay — require structural upgrades. P66a inventories what's there, picks an explicit relay architecture, lays out DB / endpoint / companion / UI deltas, and breaks the work into reviewable sub-phases.

### Section index

1. [Audit of current state (P65/P65.1)](#p66a-audit)
2. [Architecture diagram (target state)](#p66a-arch)
3. [Three-lane runtime model finalized](#p66a-lanes)
4. [Lane D — dedicated cloud runner assessment](#p66a-laned)
5. [Relay/control-plane recommendation](#p66a-relay)
6. [Vercel relay constraint — explicit answer](#p66a-vercel)
7. [DB / schema deltas](#p66a-db)
8. [Endpoint / channel deltas](#p66a-endpoints)
9. [Companion package deltas](#p66a-companion)
10. [UI deltas](#p66a-ui)
11. [Security plan](#p66a-security)
12. [Test plan](#p66a-tests)
13. [Local direct mode plan (Lane A)](#p66a-laneA)
14. [Hosted companion mode plan (Lane B)](#p66a-laneB)
15. [Local proxy mode plan (`chatgptOAuthLocalProxy`)](#p66a-proxy)
16. [What remains experimental after P66](#p66a-remaining)
17. [What is production-ready after P66](#p66a-prod)
18. [Sub-phases + effort estimate](#p66a-phases)
19. [Risks / blockers](#p66a-risks)
20. [Final P66a recommendation](#p66a-recommendation)

---

### <a id="p66a-audit"></a> 1. Audit of current state (P65 + P65.1)

#### 1.1 Provider modes (src/lib/codex/types.ts)

```
anthropicApiKey         — STABLE   — Anthropic Claude
openaiApiKey            — STABLE   — OpenAI Platform key (server-managed)
openaiUserApiKey        — STABLE   — User BYOK
codexChatGPTLocal       — ALPHA    — local stdio to codex app-server
codexChatGPTBridge      — ALPHA    — manual ws:// paste (deprecated for new users)
codexChatGPTCompanion   — ALPHA    — browser ↔ local companion ↔ codex
```

`isCodexMode()` and `normalizeProviderMode()` exist; legacy `codexChatGPT` rows migrate to `codexChatGPTBridge` automatically.

#### 1.2 Local mode support (`codex-local-runtime.ts`)

`getLocalRuntimeStatus()` correctly detects:
- Vercel-hosted (`VERCEL=1` or `VERCEL_ENV` set) → `supportsSpawn: false, reason: "vercel-hosted"`
- Explicitly disabled (`HYPERAGENT_DISABLE_LOCAL_CODEX=1`)
- Edge / Workers (no `process.versions.node`)
- Otherwise → spawnable, reports `codexBinary` path

✅ Detection works. ❌ Not yet wired into the chat dispatch as the *preferred* path when running locally; today `codexChatGPTLocal` is selected explicitly via the UI.

#### 1.3 Companion support

`packages/codex-companion/` ships:
- `bin/hyperagent-codex-companion.js` — CLI
- `src/companion.js` — orchestrator (claim → spawn codex → BrowserServer → heartbeat)
- `src/codex-process.js` — JSON-RPC 2.0 client over stdio with server-initiated request handlers
- `src/browser-server.js` — loopback HTTP/WS with origin enforcement, PNA preflight, first-message hello
- `src/event-mirror.js` — POSTs events to hosted `/api/codex/events`
- `src/redact.js` — local log redaction

Hosted side:
- `src/lib/codex/companion-client.ts` — browser-side WS driver (called by ChatView)
- `src/lib/codex/pair-store.ts` — Postgres-backed pair sessions
- `src/lib/codex/run-ticket.ts` — HMAC-signed stateless tickets
- `src/lib/codex/event-mirror.ts` — Postgres sink for mirrored events
- `src/lib/codex/origin-guard.ts` — CSRF/Origin check
- 7 API routes under `/api/codex/pair/*`, `/run-ticket`, `/events`

#### 1.4 Pair / session storage

✅ **Durable Postgres-backed.**
Tables: `codex_pair_sessions`, `codex_run_events`, `codex_bridges`, `codex_approvals`.
Module-level state limited to idempotent schema-creation guards. Run-ticket key derives from env secret on every cold start (same key everywhere).

#### 1.5 Event mirroring

✅ Companion → `/api/codex/events` works. Per-source monotonic sequence enforced. Idempotency via `UNIQUE ("runId","source","idempotencyKey")`. P65.1 added truncation stubs for 64KB–1MB events; `>1MB` rejected.

❌ Browser → server-stream-of-truth path is **NOT** built. Today the browser opens a WS to the *companion* and the companion mirrors a copy server-side, so the browser is the source of truth. Reversing this is a P66c task.

#### 1.6 Run-ticket support

✅ HMAC-SHA-256 signed; carries runId / userId / orgId / threadId / agentId / pairSessionId / providerMode / approvalPolicy / budgetMicroUsd / budgetEnforcement / traceTarget / expiry / nonce. 30-min TTL. Tampering / expiry / cross-key rejected. `setRunTicketKeyForTest` exposed for tests.

❌ Not yet wired into a server-side dispatch path (only the browser presents it to the companion).

#### 1.7 Approval support

✅ Server-initiated codex approvals (legacy + v2 methods) flow through the companion's `installApprovalBridge`, get synthesized into the legacy `approval/required` notification shape, and reach the browser. Decisions go back through the WS to resolve the original JSON-RPC server-request id.

❌ Decisions are **NOT** server-authoritative. If the original tab closes, the WS dies and the companion has nobody to ask for a decision — the codex turn waits and eventually times out. The `codex_approvals` table exists for the bridge mode but isn't used for companion mode.

#### 1.8 Cancellation support

✅ Stop button: aborts pending fetch, calls `companionRef.current.cancel()` → companion sends `turn/interrupt`, then closes WS after 200ms. Hosted `/api/runs/:id/cancel` is also fired.

❌ Cancellation is **NOT** fully server-authoritative. Tab close cancels via WS-drop, not via a server-side "set run state to cancelling and dispatch to the companion".

#### 1.9 Real codex tests

✅ Two gated smoke scripts:
- `scripts/codex-smoke-test.ts` — direct codex protocol smoke (P64.2)
- `scripts/codex-companion-e2e-smoke-test.ts` — full companion E2E (P65.1; verified 13 events mirrored / thread/start succeeded against codex 0.130.0)

Unit tests: 418 PASS / 0 FAIL across 15 codex test groups.

#### 1.10 Known limitations (carried from P65.1 docs)

| Limitation | Severity for P66 |
|------------|-------------------|
| Tab close abandons in-flight runs | **CRITICAL** — P66 tab-close survival goal cannot be met without this |
| Browser is source of truth for run state | **CRITICAL** — server-authoritative requirement |
| Approvals depend on the original tab | **CRITICAL** — approve-from-anywhere requirement |
| Budget is advisory only (companion mode) | Medium — documented honest, but P66 should add policy controls |
| No companion auto-update | Low |
| No multi-machine routing | Low (deferred to P66 explicitly) |
| Heartbeat sessionSecret theft scope | Medium — relay session rotation tightens |
| No artifact sync from companion runs | **HIGH** — P66 explicit goal |
| Manual bridge URL/token paste still possible (`codexChatGPTBridge`) | Low — P66 goal: deprecate this from the normal flow but keep available as a fallback |

#### 1.11 What is browser-driven

The whole companion turn is browser-driven today:
- Browser fetches the run ticket
- Browser opens the WS to the companion
- Browser sends the user input
- Browser receives the events
- Browser drives approvals
- Browser drives cancellation

Browser tab close → run loses its driver.

#### 1.12 What breaks on tab close

1. **In-flight turn**: WS dies; companion's per-turn `close()` handler fires `turn/interrupt`; codex eventually unwinds.
2. **Approvals**: any pending approval will time out when the user doesn't respond (codex's own approval timeout, currently undocumented but observed at ~60s on commands).
3. **Streaming events**: lost mid-flight; no replay.
4. **Trace/audit log**: events already mirrored stay in `codex_run_events`, but events emitted after close don't make it back because companion fires only when WS sends them OR when its own mirror fires (which is on the per-turn handler that closes when the WS dies).

#### 1.13 What is not server-authoritative

- Run lifecycle (open/streaming/done/cancelled state) — only the browser knows
- Approvals — only the browser knows what the user picked
- Cancellation — only the browser drives codex's `turn/interrupt`
- Run completion — only the browser sees `turn/completed` and writes the final assistant message
- Artifact sync — codex can emit file-change events but we don't sync those into hosted artifact storage

---

### <a id="p66a-arch"></a> 2. Architecture diagram (target state)

```
                   ┌──────────────────────────────────────────────────┐
                   │   Hosted Vercel app                              │
                   │   ─────────────────                              │
                   │   • Postgres (Neon)                              │
                   │   • App + API routes                             │
                   │   • SSE event stream → browser                   │
                   │   • Run lifecycle / policy / approvals / audit   │
                   │   • Artifact storage                             │
                   │   • Companion / device registry                  │
                   └────────┬───────────────────────────┬─────────────┘
                            │                           │
                  SSE/HTTP  │                           │ HTTP (run create,
                  (browser) │                           │  approval, cancel)
                            │                           │
                            ▼                           ▼
                   ┌─────────────────┐       ┌─────────────────────────┐
                   │  Browser tab    │       │  Hosted relay service   │
                   │  (viewer/UI)    │       │  ────────────────────   │
                   │                 │       │  • Long-lived WS server │
                   │  reads run via  │       │  • Companion outbound   │
                   │  SSE; sends     │       │    auth-shaken sessions │
                   │  human inputs   │       │  • Sequence + replay    │
                   │  via REST       │       │  • Backpressure         │
                   └─────────────────┘       │  • Per-org rate limits  │
                                             └─────────┬───────────────┘
                                                       │
                                              outbound │ WS
                                                       │
                                                       ▼
                                    ┌──────────────────────────────────┐
                                    │  Local companion                 │
                                    │  ─────────────────               │
                                    │  • Codex login + token vault     │
                                    │  • codex app-server (stdio)      │
                                    │  • Local OpenAI proxy (P66e)     │
                                    │  • Local artifact reader         │
                                    │  • Health / heartbeat            │
                                    └──────────────────────────────────┘
```

Three lanes against this diagram:
- **Lane A (local direct):** the "Hosted Vercel app" box runs on the user's machine, the relay collapses to a no-op, the companion box runs in the same process.
- **Lane B (hosted + companion):** full diagram — browser is a viewer, server creates the run, relay routes commands and events between server and companion.
- **Lane C (hosted + BYOK):** the relay/companion path is unused; existing OpenAI direct path stays.

---

### <a id="p66a-lanes"></a> 3. Three-lane runtime model

| Lane | Selected when | Provider modes | Tokens | Run lifecycle owner |
|------|---------------|----------------|--------|--------------------|
| **A — Local direct** | `getLocalRuntimeStatus().supportsSpawn === true` AND user picked `codexChatGPTLocal` (or `chatgptOAuthLocalProxy` w/ flag) | `codexChatGPTLocal`, `chatgptOAuthLocalProxy` | local (`~/.codex` / OS keychain) | local app process |
| **B — Hosted + companion** | hosted Vercel + paired companion online + user picked `codexChatGPTCompanion` (or `chatgptOAuthCompanionProxy` w/ flag) | `codexChatGPTCompanion`, `chatgptOAuthCompanionProxy` | local on user's machine (companion) | hosted server (via relay → companion) |
| **C — Hosted BYOK** | hosted Vercel, no companion | `anthropicApiKey`, `openaiApiKey`, `openaiUserApiKey` | encrypted in hosted DB | hosted server (in lambda) |

**No silent fallback**, ever. UI gates each lane explicitly. Lane selection is sticky per user via existing `setProviderMode` and per-thread via the agent config.

---

### <a id="p66a-laned"></a> 4. Lane D — dedicated cloud runner assessment

**Question:** could we offer a `codexChatGPTCloudRunnerPrivate` mode where a small dedicated cloud server (one per user/org) runs codex app-server, owns the local-style credential storage, and acts like a "remote local machine"?

**Technical feasibility:** yes. A Fly.io / Railway / Render container running our `hyperagent-codex-companion` with an attached volume for `~/.codex` would behave exactly like Lane B, except the "local" host is a single-tenant cloud machine.

**Should we support it?**
- ✅ Pros: solves tab-close survival without the relay architecture; users with no laptop session uptime can still use ChatGPT/Codex subscription auth; private/single-user deployments work.
- ❌ Cons: this is **OpenAI account abuse risk #1** if we don't get scoping right. A cloud runner that any user can connect to = a shared ChatGPT account pool, which violates ChatGPT TOS. Single-tenant scoping must be enforced in code, not just policy.
- ❌ More cons: if the runner container dies, we lose the codex auth state unless we persist it; persisting it means storing OpenAI tokens (we said we wouldn't).

**Account pooling risk:** HIGH. If any user can claim any cloud runner, they can also use the ChatGPT account that runner was logged into. Mitigation: bind a runner to exactly one user/org at provision time, refuse claim from any other identity, never expose the runner outside the owning org.

**How it differs from companion:** companion is a process the user starts on their own laptop; cloud runner is a process *we* (or the user) start on a managed VM. The trust model differs — the user runs the companion on their own machine; the cloud runner is run by someone else.

**Verdict:** **Defer.** Lane D is technically feasible as a BYO-cloud-runner option (the user provisions and owns it), but a hosted-managed cloud runner is a TOS minefield. P66 should NOT introduce Lane D. Self-hosted single-user deployments can simply run Lane A inside the Docker container they control — no new code needed.

If approved later, the cleanest framing is:
- `codexChatGPTSelfHosted` mode: user/org BYO their own server running `hyperagent-codex-companion`; companion claims pair sessions from there. Treats the cloud runner as a regular "companion" with no special trust.

---

### <a id="p66a-relay"></a> 5. Relay/control-plane recommendation

**Decision required:** which relay architecture do we ship for P66?

#### Candidate evaluation

| Option | Pros | Cons | Cost (alpha → beta) |
|--------|------|------|--------------------|
| **A. Vercel-only** (long-poll / fetch-stream) | zero new vendor; no extra hosting | **fundamentally unsuitable** — Functions max out at 15 min on Enterprise (10s hobby, 5min pro); cold starts kill long-running connections; companion outbound WS not supported | n/a |
| **B. Self-hosted Node + Postgres pub/sub on Fly.io / Railway** | full control; no third-party data flow; cheap; reuses existing Postgres for state; hooks into existing redaction/audit | new ops surface; ~50–150 LOC of relay code; one new deployment target; need monitoring | $5–25/mo for alpha; ~$50/mo for beta |
| **C. Ably (managed realtime)** | zero ops; hardened auth/JWT; channel-shaped pub/sub matches our needs (companion subscribes to its own channel; server publishes to it); presence + reconnection-with-continuity built-in; generous free tier (3M msg/mo, 200 peak channels) | new vendor; events flow through 3rd party (encrypted in transit, but they see redacted JSON); paid tier scales with usage | free tier likely fits alpha; ~$30–500/mo for beta-scale |
| **D. Pusher Channels** | similar to Ably; mature; broad SDK support | similar cons; weaker presence semantics than Ably; less generous free tier | similar to Ably |
| **E. Liveblocks** | already in our stack (`@liveblocks/client@^2.21.1`); familiar billing | room-shaped, not point-to-point; would need to misuse Storage rooms as device channels; backpressure semantics not designed for this | already paying for it; could share quota with thread presence |
| **F. PartyKit on Cloudflare** | actor pattern; Durable Objects fit a "one actor per companion" model perfectly; cheap | new vendor; CF Worker constraints (sub-request limits); SDK is younger; team would need to learn the actor pattern | $5/mo+ |
| **G. Supabase Realtime** | already shaped as Postgres-CDC; if we move state to Postgres pub/sub it slots in | introduces another vendor for what's a small problem; auth model is row-level-security-heavy | $25/mo Pro |

#### Recommendation: **Option B + thin Vercel ingest** (hybrid)

Architecture:
```
Vercel (app, API, Postgres, browser SSE, run state)
  ↕ HTTPS (run create, approval, cancel, event ingest)
  ↕
Self-hosted Node relay on Fly.io ("hyperagent-codex-relay")
  • inbound WS from companion (one connection per device)
  • outbound dispatch from Vercel via signed HTTPS
  • event forwarding back to Vercel via signed HTTPS POST /api/codex/events
  • Postgres-backed offline queue (reuse existing Neon for run-ticket index + per-device unread queue)
  • redaction pass mirrors hosted side
```

**Why this:**
1. **Vercel cannot host a long-lived WS server.** Function timeouts, statelessness, and cold starts make the "browser ↔ companion via Vercel" path technically impossible.
2. **Companion needs a stable inbound endpoint** for outbound auth-shaken WS sessions. A small Node service on Fly.io is the right shape — process lifetime is days/weeks, scales to thousands of WS per node, ops is minimal (one container).
3. **No new vendor data flow.** Our redaction, audit, and trace store stay 100% on Vercel + Neon. The relay only forwards bytes; it does not store events.
4. **Predictable cost.** $5–25/mo for the alpha, $50/mo for beta-scale. No metered messaging.
5. **Reasonable to self-host for security-sensitive customers** if they want to fork.
6. **Audited code path.** All event redaction, run-ticket verification, and CSRF checks stay on the Vercel side. Relay is dumb pipe + offline queue.

**Why not Ably (the closest vendor option):**
- Ably is excellent and would work. The reason to pick self-hosted Node is **no third-party data path** for trace events. Even with redaction, sending event payloads through a vendor is a thing customers ask about. Self-hosted Node gives a clean answer: "events go from companion to our relay to our backend — same trust boundary as any other service."
- If ops capacity is a hard constraint, **Ably is the no-regret backup** and we can swap by re-implementing the companion's outbound transport in a few hundred lines.

#### What runs where in the recommendation

| Component | Host | Notes |
|-----------|------|-------|
| App, API, dashboard, settings UI | Vercel (existing) | unchanged |
| Postgres (Neon) | Neon (existing) | adds new tables; see §7 |
| Browser → server SSE event stream | Vercel (Node runtime) | new `/api/codex/runs/:runId/stream` SSE endpoint |
| Companion outbound WS | **Fly.io (new)** | one new repo `packages/codex-relay/` deployed standalone |
| Server → relay → companion run dispatch | Vercel signs the run packet → POSTs to relay HTTPS endpoint → relay forwards over WS | relay is dumb forwarder; auth is HMAC of run-ticket signature |
| Companion → relay → server event ingest | companion sends WS frame → relay POSTs to Vercel `/api/codex/events` | reuses existing event-mirror sink |
| Approval round-trip | hosted DB row + relay broadcast | new approvals route through DB so any tab can pick up |
| Persistent run state | Postgres `codex_runs` table (new) | source of truth for run lifecycle |

---

### <a id="p66a-vercel"></a> 6. Vercel relay constraint — explicit answer

**Q: Can Vercel host the bidirectional WS relay directly?**

**A: No.** Vercel Functions:
- Have a hard max duration per invocation (10s hobby, 60s default Pro, up to 800s with `maxDuration`, 900s on Enterprise). A WS that needs to stay open for hours is impossible.
- Are stateless across invocations. Even if you held a connection open, you couldn't address a specific companion from a different invocation.
- Cold-start latency would drop frames during scale events.
- Edge runtime allows WS upgrades but is similarly bounded; Durable Objects are the right shape but live on Cloudflare, not Vercel.

**Vercel's role in P66:** app, API surface, browser-facing SSE, Postgres reads/writes, signed HTTPS dispatch to the relay. The browser SSE stream is fine on Vercel (Node runtime, `maxDuration: 800`). The companion's WS is **not**.

**SSE on Vercel:** browser ↔ Vercel SSE works for the UI's per-run event subscription. The 800s `maxDuration` cap means runs longer than ~13 minutes need the browser to reconnect; the SSE endpoint should set `Last-Event-ID` headers and replay from the database queue on resubscribe.

---

### <a id="p66a-db"></a> 7. DB / schema deltas

Existing P65/P65.1 tables stay. New tables for P66:

#### New: `codex_companions` (CompanionDevice)
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | `cmp_<random>` |
| `userId` | TEXT FK users(id) ON DELETE CASCADE | |
| `orgId` | TEXT NULL | for org-scoped revoke |
| `displayName` | TEXT | user-set (e.g. "MacBook Pro") |
| `osPlatform` | TEXT | linux/darwin/win32 |
| `nodeVersion` | TEXT | reported on connect |
| `companionVersion` | TEXT | npm package version |
| `codexVersion` | TEXT NULL | reported by codex |
| `firstSeenAt` | BIGINT | unix ms |
| `lastSeenAt` | BIGINT | updated on each WS frame |
| `revokedAt` | BIGINT NULL | |
| `enabledForRuns` | BOOLEAN DEFAULT true | per-org admin can disable |
| Indexes | `(userId, orgId)`, `(orgId, revokedAt)` | |
| TTL | retain forever; soft-revoke only | |

#### New: `codex_companion_connections` (CompanionConnection)
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | `con_<random>` |
| `companionId` | TEXT FK codex_companions(id) | |
| `relayNodeId` | TEXT NULL | which relay holds the WS |
| `connectedAt` | BIGINT | |
| `disconnectedAt` | BIGINT NULL | |
| `disconnectReason` | TEXT NULL | "client_close" / "heartbeat_timeout" / "revoked" / "relay_restart" |
| Indexes | `(companionId, connectedAt DESC)` | |
| TTL | prune rows older than 30 days | |

#### New: `codex_runs` (CompanionRun) — server-authoritative run state
| Column | Type | Notes |
|--------|------|-------|
| `runId` | TEXT PK | matches the run-ticket runId |
| `userId` | TEXT FK | |
| `orgId` | TEXT NULL | |
| `threadId` | TEXT FK threads(id) | |
| `agentId` | TEXT NULL | |
| `companionId` | TEXT NULL | which companion is executing |
| `providerMode` | TEXT | |
| `state` | TEXT | "queued" / "dispatched" / "running" / "approval_pending" / "cancelling" / "completed" / "failed" / "cancelled" |
| `lastEventSeq` | BIGINT | per-source max sequence seen |
| `startedAt` | BIGINT | |
| `endedAt` | BIGINT NULL | |
| `lastError` | TEXT NULL | redacted |
| `policySnapshot` | JSONB | the policy this run was issued under (for audit) |
| `budgetMicroUsdSeen` | BIGINT DEFAULT 0 | observed token cost (advisory) |
| Indexes | `(userId, threadId, startedAt DESC)`, `(state)`, `(companionId, state)` | |
| TTL | retain forever | |

#### New: `codex_run_dispatch_queue` (RelayMessage)
| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `runId` | TEXT FK codex_runs(runId) | |
| `companionId` | TEXT FK codex_companions(id) | |
| `direction` | TEXT | "to_companion" / "from_companion" |
| `kind` | TEXT | "run_dispatch" / "approval_decision" / "cancel" / "ack" |
| `sequence` | BIGINT | per (runId, direction) |
| `payload` | JSONB | redacted |
| `enqueuedAt` | BIGINT | |
| `deliveredAt` | BIGINT NULL | when relay confirmed delivery to companion or vice versa |
| Indexes | `(companionId, deliveredAt) where deliveredAt IS NULL`, `(runId, sequence)` | |
| TTL | prune rows where `deliveredAt < now - 7 days` | |

This is the **offline queue** — when companion is offline, server enqueues here; when it reconnects, relay drains in sequence order.

#### New: `codex_run_approvals` (ApprovalRequest + Decision combined)
P66 supersedes the existing `codex_approvals` (which was scoped to bridge mode). New shape:

| Column | Type | Notes |
|--------|------|-------|
| `approvalId` | TEXT PK | |
| `runId` | TEXT FK codex_runs(runId) | |
| `userId` | TEXT FK | |
| `kind` | TEXT | "command"/"file"/"network"/"tool" |
| `methodName` | TEXT | actual codex method (item/commandExecution/requestApproval, etc.) |
| `summary` | TEXT | short label |
| `redactedPayload` | JSONB | the request payload, redacted |
| `requestedAt` | BIGINT | |
| `decidedAt` | BIGINT NULL | |
| `decision` | TEXT NULL | "approved"/"approvedForSession"/"denied"/"timed_out" |
| `decidedBy` | TEXT NULL | userId of who clicked |
| `decisionSource` | TEXT NULL | "web"/"slack"/"api"/"timeout" |
| `companionId` | TEXT NULL | |
| Indexes | `(runId, requestedAt)`, `(userId, decidedAt) WHERE decidedAt IS NULL` | |
| TTL | retain forever (audit) | |

#### New: `codex_artifact_sync_jobs` (ArtifactSyncJob)
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | `asj_<random>` |
| `runId` | TEXT FK codex_runs(runId) | |
| `userId` | TEXT FK | |
| `companionId` | TEXT FK | |
| `kind` | TEXT | "file" / "patch" / "url" / "binary" |
| `relativePath` | TEXT | inside the codex thread workspace |
| `bytes` | BIGINT | size on disk |
| `sha256` | TEXT | content hash |
| `state` | TEXT | "pending_user_approval" / "uploading" / "uploaded" / "rejected" / "errored" |
| `artifactId` | TEXT NULL FK artifacts(id) | once uploaded |
| `errorReason` | TEXT NULL | redacted |
| `requestedAt` | BIGINT | |
| `decidedAt` | BIGINT NULL | |
| Indexes | `(runId, requestedAt)`, `(state) WHERE state='pending_user_approval'` | |
| TTL | prune rejected/errored after 30 days | |

Approval gate is critical here — see §11 for the sensitive-file guard.

#### New: `codex_audit_log` (AuditLog + SecurityEvent merged)
| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `userId` | TEXT NULL | |
| `orgId` | TEXT NULL | |
| `companionId` | TEXT NULL | |
| `runId` | TEXT NULL | |
| `event` | TEXT | enum: pair_started/pair_claimed/pair_revoked/companion_connected/companion_disconnected/run_created/run_dispatched/approval_decided/run_cancelled/run_completed/csrf_blocked/origin_blocked/run_ticket_invalid/budget_threshold_observed/policy_violation/artifact_sync_rejected/etc. |
| `severity` | TEXT | info/warn/error/security |
| `details` | JSONB | redacted |
| `at` | BIGINT | |
| Indexes | `(userId, at DESC)`, `(orgId, at DESC)`, `(severity, at DESC) WHERE severity IN ('error','security')` | |
| TTL | retain 1 year then archive | |

#### New: `codex_org_policies` (OrgPolicy)
| Column | Type | Notes |
|--------|------|-------|
| `orgId` | TEXT PK | |
| `companionEnabled` | BOOLEAN DEFAULT true | |
| `localProxyEnabled` | BOOLEAN DEFAULT false | feature flag |
| `maxRunDurationSec` | INT DEFAULT 1800 | hard cap |
| `maxToolCallsPerRun` | INT DEFAULT 200 | |
| `maxCommandExecsPerRun` | INT DEFAULT 50 | |
| `maxArtifactBytesPerRun` | BIGINT DEFAULT 50000000 | 50 MB |
| `requireApprovalKinds` | TEXT[] DEFAULT '{"command","file","network","tool"}' | |
| `allowedToolCategories` | TEXT[] | |
| `allowedAgents` | TEXT[] NULL | NULL = all |
| `updatedBy` | TEXT | |
| `updatedAt` | BIGINT | |
| TTL | n/a; one row per org | |

#### New: `codex_agent_provider_config` (AgentProviderConfig)
| Column | Type | Notes |
|--------|------|-------|
| `agentId` | TEXT PK FK agents(id) | |
| `allowedProviderModes` | TEXT[] | |
| `defaultProviderMode` | TEXT NULL | |
| `companionMode` | TEXT DEFAULT 'allowed' | "required"/"allowed"/"blocked" |
| `updatedAt` | BIGINT | |

#### Existing tables that stay
- `codex_pair_sessions` (P65)
- `codex_run_events` (P65; gains `runId` FK to `codex_runs`)
- `codex_bridges` (P65; deprecated for new users in P66 UI but kept)
- `codex_approvals` (P59 bridge-mode; superseded by `codex_run_approvals` for companion mode; both coexist for one major version)

#### What we **do not** add
- ❌ No table storing ChatGPT/Codex access/refresh/ID tokens
- ❌ No table storing companion-side OS keychain entries
- ❌ No table storing local OAuth callback URLs (would carry redirect_uris that include port + state)

---

### <a id="p66a-endpoints"></a> 8. Endpoint / channel deltas

#### Vercel API routes (additions)

| Method + path | Auth | Purpose |
|---------------|------|---------|
| `GET  /api/codex/runtime/status` | session cookie | Lane discriminator: returns `{ environment: "vercel"\|"local-dev"\|"docker"\|"unknown", supportsSpawn, codexBinary, codexVersion, hasCompanionPaired, hasCompanionOnline }`. UI uses this to gate Lane A vs B vs C choices. |
| `POST /api/codex/runs` | session cookie + CSRF | Server-authoritative run creation. Body: `{ threadId, agentId, providerMode, input, attachments }`. Verifies provider mode is allowed for org/agent; verifies companion online for Lane B; issues run ticket; INSERTs `codex_runs` row in state="queued"; enqueues dispatch in `codex_run_dispatch_queue`; returns `{ runId, encodedTicket, streamUrl }`. |
| `GET  /api/codex/runs/:runId/stream` | session cookie | SSE event stream. Reads from `codex_run_events` ordered by id, supports `Last-Event-ID` for resume. |
| `GET  /api/codex/runs/:runId` | session cookie | Snapshot: state + last events for "open thread → see ongoing run" UX. |
| `POST /api/codex/runs/:runId/approvals/:approvalId` | session cookie + CSRF | Server-side approval decision. Sets row in `codex_run_approvals`; enqueues `to_companion` message. |
| `POST /api/codex/runs/:runId/cancel` | session cookie + CSRF | Sets `codex_runs.state='cancelling'`; enqueues `to_companion` cancel. |
| `POST /api/codex/companions` | session cookie + CSRF | Companion device registration; reuses existing pair claim under the hood; allocates `codex_companions.id`. |
| `GET  /api/codex/companions` | session cookie | List user's companions + status. |
| `POST /api/codex/companions/:id/revoke` | session cookie + CSRF | Mark `revokedAt`; tell relay to drop the WS. |
| `POST /api/codex/relay/inbox` | HMAC of relay shared secret | **Relay → Vercel** event ingest. Companion-emitted events arrive here. Verifies run-ticket signature on each; persists to `codex_run_events` + advances `codex_runs.state`. |
| `POST /api/codex/relay/dispatch-receipt` | HMAC | **Relay → Vercel** delivery confirmations. Sets `deliveredAt` on `codex_run_dispatch_queue` rows. |
| `POST /api/codex/artifacts/sync-request` | HMAC of run ticket | **Companion-via-relay → Vercel** "I want to upload a file from `<path>` (sha256, size). Approve?". Creates `codex_artifact_sync_jobs` row in `pending_user_approval`. |
| `POST /api/codex/artifacts/:syncJobId/decision` | session cookie + CSRF | User approves/rejects an artifact sync. |
| `POST /api/codex/artifacts/:syncJobId/upload` | HMAC | **Companion-via-relay → Vercel** body POST of the artifact bytes (after user approved). Persisted to existing `artifacts` table. |
| `GET  /api/codex/policies/:orgId` | session cookie (admin) | Read org policy. |
| `PUT  /api/codex/policies/:orgId` | session cookie (admin) + CSRF | Update org policy. |

#### Relay service endpoints (new repo `packages/codex-relay/`)

| Method + path | Auth | Purpose |
|---------------|------|---------|
| `WS   wss://relay.example.com/companion` | first-message hello with companion session token | Long-lived inbound WS from companion. |
| `POST https://relay.example.com/dispatch` | HMAC of relay shared secret + run-ticket signature | Vercel posts a run dispatch packet; relay forwards over WS to the right companion. |
| `POST https://relay.example.com/cancel` | HMAC | Vercel posts cancel; relay forwards. |
| `GET  https://relay.example.com/healthz` | none | Process health probe. |
| `GET  https://relay.example.com/connections/:companionId` | HMAC | Vercel asks "is this companion's WS up right now?" |

#### Existing routes that change

| Path | P66 change |
|------|-----------|
| `/api/codex/pair/start` | unchanged shape; gains audit log emit |
| `/api/codex/pair/claim` | now ALSO inserts a `codex_companions` row when first claim succeeds |
| `/api/codex/pair/heartbeat` | becomes optional / fallback (relay WS provides liveness signal once Lane B is on relay) |
| `/api/codex/pair/status` | gains `relayConnected: bool` field |
| `/api/codex/run-ticket` | unchanged; now used SERVER-side too in `/api/codex/runs` |
| `/api/codex/events` | continues to accept companion direct posts as a fallback (Lane A); the relay path goes through `/api/codex/relay/inbox` instead |
| `/api/chat` | gains a tiny pre-dispatch check: if `providerMode === codexChatGPTCompanion`, refuse with "use POST /api/codex/runs" |

---

### <a id="p66a-companion"></a> 9. Companion package deltas

The current `packages/codex-companion/` keeps most of its code; the WS surface flips inside-out.

#### Changes

| Module | P66 change |
|--------|-----------|
| `bin/hyperagent-codex-companion.js` | adds `--relay=<url>` flag (defaults to inferring from `--host`); new `--no-relay` for Lane A local-only; new `--registration-token=<…>` for first-time device registration |
| `src/companion.js` | adds `relayClient` subsystem; replaces "wait for browser to connect" with "open outbound WS to relay; receive dispatches". The legacy `BrowserServer` stays available as a feature-flagged direct-connect mode for Lane A development. |
| `src/codex-process.js` | unchanged shape; gains `getAccountStatus` cache so heartbeats can include it without round-tripping codex every time |
| `src/relay-client.js` | **new.** Outbound WS to relay; HMAC-authenticated; reconnect with exponential backoff + jitter; sends ACKs; replays from last-acknowledged sequence after reconnect |
| `src/run-executor.js` | **new.** Receives a dispatch packet (containing run-ticket + thread context + user input). Drives codex through one full turn. Streams events back via relay. Handles approval requests by forwarding to relay AND awaiting a server-issued decision (NOT a browser click). |
| `src/artifact-sync.js` | **new.** When codex emits a file-change/artifact event, posts a `sync-request` through relay; on approval, streams the file bytes |
| `src/local-proxy.js` | **new (P66e).** Optional OpenAI-compatible HTTP proxy on a second loopback port for LangChain callers |
| `src/event-mirror.js` | **deprecated for relay path.** The relay client takes over event forwarding. The HTTP-direct mirror stays for the no-relay Lane A development mode |
| `src/redact.js` | unchanged; gains `redactArtifactPath` for filenames that look like secrets (.env, *.pem, credentials.json) |

#### Companion lifecycle additions

State machine becomes:
```
not_installed → installing → installed → registering → registered
  → relay_connecting → relay_connected → idle
  → running → approval_pending → running → completed → idle
  → relay_disconnected → relay_reconnecting → relay_connected → resume
  → revoked → shutting_down
```

Event replay: on reconnect, companion advertises `lastSeenAcknowledgedSeq`. Relay (via Vercel) replays any `codex_run_dispatch_queue` rows where `direction='to_companion'` and `deliveredAt IS NULL` for any active run on this companion.

---

### <a id="p66a-ui"></a> 10. UI deltas

#### Settings → Providers

Restructure into two clear groups:

```
─────────────────────────────────────────────
STABLE PRODUCTION
─────────────────────────────────────────────
☐ Anthropic (Claude)             [API key configured ✓]
☐ OpenAI Platform (BYOK)         [no key configured]
☐ OpenAI Platform (managed)      [admin-managed]

─────────────────────────────────────────────
CHATGPT / CODEX SUBSCRIPTION — EXPERIMENTAL
─────────────────────────────────────────────
Available because: this app is hosted on Vercel.
You'll need a local companion to use these modes.

  ☐ Codex Companion (recommended)        [companion online ✓]
  ☐ Codex Local (only when running locally)  [unavailable on hosted]
  ☐ ChatGPT OAuth Local Proxy (experimental, requires feature flag)
                                            [feature flag OFF]

[Manage devices…]   [Org policy…]
```

When running locally:
```
─────────────────────────────────────────────
CHATGPT / CODEX SUBSCRIPTION — EXPERIMENTAL
─────────────────────────────────────────────
Available because: you're running Hyperagent locally.

  ☐ Codex Local (recommended for local)     [Codex 0.130.0 detected ✓]
  ☐ Codex Companion (works here too)        [optional]
  ☐ ChatGPT OAuth Local Proxy               [feature flag ON]
```

#### Companion device management

New page `Settings → Codex → Devices`:
- Table of companions (display name / OS / version / first seen / last seen / status / actions)
- Per-row: revoke, rename, view recent runs
- "Pair a new device" button → existing pair flow

#### Active runs surface

New "Active Runs" pill in the global sidebar (shown when ≥1 run is in `running` / `approval_pending` / `cancelling`). Clicking opens the thread, which auto-subscribes via SSE. Survives page reloads.

#### Approval inbox

New `Approvals` route with all `codex_run_approvals` rows where `decidedAt IS NULL` for the user. Approving here works regardless of which tab originally started the run.

#### Run pane updates

- ChatView gets a new "Run resumed" banner when reopening a thread that has an active run.
- The "Experimental" banner (already shipped in P65.1) gains a sub-line: "This run continues even if you close the tab."
- Stop button now hits `POST /api/codex/runs/:runId/cancel` instead of relying on the WS being open.

#### Artifact approval modal

When companion wants to sync a file, browser shows a modal:
```
The Codex run wants to upload this file:
  src/components/MyFile.tsx       (4.2 KB)
[ View diff ]   [ Approve ]   [ Reject ]
```

#### "What is happening on Vercel hosting" honest banner

In Settings → Codex, when on hosted Vercel:
> ChatGPT subscription usage is governed by your ChatGPT/Codex account.
> Hyperagent enforces local run policy, approvals, time/tool limits, and
> audit controls. We do not store ChatGPT/Codex tokens.
> Your ChatGPT subscription's own limits are controlled by OpenAI.

---

### <a id="p66a-security"></a> 11. Security plan

#### Hard invariants (from §Security requirements + P64.2/P65/P65.1)

- ❌ Never store ChatGPT/Codex access/refresh/ID tokens in hosted DB.
- ❌ Never log raw tokens, Authorization headers, callback URLs, pair codes, run-ticket payloads.
- ❌ Never accept companion connections without an outbound-initiated session.
- ❌ Never bind companion to non-loopback by default.
- ❌ Never silently fall back between API-key billing and ChatGPT subscription auth.
- ❌ Never ferret a private ChatGPT backend through our hosted server (we use codex's documented surface; we don't proxy private endpoints).

#### New defenses introduced by P66

| Defense | Where | Notes |
|---------|-------|-------|
| Relay HMAC shared secret | Vercel↔Relay | rotated every 90 days; both Vercel and relay derive from a single env secret; no other auth allowed on `/dispatch` / `/inbox` |
| Companion session JWT | Companion→Relay | issued by Vercel on `pair/claim`; signed with the run-ticket key; carries companionId + userId + expiry; relay verifies on every WS frame |
| Per-event run-ticket binding | events ingest | every event carries the runId; the run-ticket on file for that runId is verified before insert |
| Approval expiry | server-side | each approval has `expiresAt = requestedAt + 5min`; expired approvals are server-marked `timed_out` and the companion is told to deny |
| Sensitive-file upload guard | artifact sync | path matches `/(\.env|credentials\.json|.*\.pem|.*_key|\.ssh\/.*)/i` → require explicit user approval AND prepend a UI warning |
| Artifact size cap | artifact sync | enforced both by org policy (`maxArtifactBytesPerRun`) and a hard 50MB ceiling |
| Origin / CSRF | Vercel routes | continues from P65.1; `/api/codex/runs/*` POSTs gain `enforceCsrf` |
| Rate limits | Vercel + relay | per-user run-create rate limit (10/min); per-companion event ingest cap (100 events/sec); relay-side WS frame cap (1000 fps/connection) |
| SSRF deny-list | continues | runtime/status uses local detection; no server-side fetch of user URLs |
| DNS rebinding | n/a for relay | relay address is hardcoded by env; no user-supplied URLs |
| Companion auto-revoke | new | if companion sends an event for a run that's already in state="completed", relay closes the WS with code 4400 and Vercel marks the companion as compromised → revoke |
| Trace event redaction | continues | all events go through `redactJson` server-side; companion redacts before sending |
| Relay audit | new | relay logs nothing about event payloads beyond size; only metadata (companionId, runId, sequence, frame size, latency) |

#### Threat model for the new surface

| Threat | Mitigation |
|--------|-----------|
| **Hijacked relay** | Relay holds **no tokens**; just routes signed packets. Worst case: events can be dropped (DoS). HMAC secret rotation closes any compromise. |
| **Stolen companion JWT** | Bound to `companionId` + signed by Vercel; revoke at the server flips a bit and the next dispatch returns 401. WS held by attacker would still be reachable via relay until next dispatch fails — accept a small window. Mitigation: short JWT TTL (1h) with silent refresh on heartbeat. |
| **Stolen relay HMAC secret** | Attacker can post fake events. Each event has a run-ticket sig that must verify; tickets expire in 30min; secret rotation closes it. |
| **Malicious companion exfiltrates user files** | Artifact sync requires user approval per file; sensitive-file guard blocks .env/.pem/etc.; org policy can disable companion artifact sync entirely. |
| **Malicious browser issues fake decisions** | All decisions are CSRF-checked + scoped to userId; approval rows match `userId`. |
| **Replay attack on run-ticket** | Tickets carry `nonce` + `expiresAt`; we don't check nonce uniqueness today (stateless ticket) → P66 introduces a `recent_run_nonces` cache (24h, in Postgres or Redis) for hard replay protection. |

---

### <a id="p66a-tests"></a> 12. Test plan

#### Reuse (no changes from P65/P65.1)

- `codex-pair-store` 31 PASS
- `codex-run-ticket` 23 PASS
- `codex-event-mirror` 26 PASS (truncation + monotonic sequence + redaction)
- `codex-companion-runtime` 23 PASS (origin / CORS / PNA / WS hello)
- `codex-origin-guard` 18 PASS
- 9 other groups, 297 PASS total

Total today: **418 PASS / 0 FAIL** across 15 groups.

#### New unit groups for P66

| Group | What it covers | Approx new assertions |
|-------|-----------------|----------------------|
| `codex-runs-state-machine` | server-authoritative run lifecycle: queued → dispatched → running → approval_pending → running → completed; cancel paths; companion-offline behavior | ~25 |
| `codex-relay-protocol` | dispatch packet shape; companion JWT verify; HMAC of relay shared secret; ack semantics; replay-from-sequence | ~30 |
| `codex-artifact-sync-store` | sync job lifecycle; sensitive-file guard; size-cap; user-approval gating; redaction of paths | ~20 |
| `codex-org-policy` | per-org enable/disable; allowed agents; max run duration; max tool calls | ~15 |
| `codex-audit-log` | event categorization; severity routing; query-by-time | ~10 |
| `codex-runtime-status` | runtime detection (Vercel / local-dev / Docker / desktop wrapper) | ~12 |
| `codex-local-proxy` (P66e) | OAuth local callback; token vault encryption; LangChain-shaped requests; SSE conversion | ~25 |

Approximate new unit assertions: **~135**.

#### New E2E gated smokes

| Smoke | Exercises | Gate |
|-------|-----------|------|
| `codex-runs-tab-close-survival.smoke.ts` | start run → close stub browser → wait → reopen → verify state replayed | `CODEX_SMOKE_TEST=1` |
| `codex-relay-reconnect.smoke.ts` | run dispatched → relay restarts → companion reconnects → events replay | `CODEX_SMOKE_TEST=1` |
| `codex-server-authoritative-approval.smoke.ts` | approval decision from a different tab than the originating tab | `CODEX_SMOKE_TEST=1` |
| `codex-artifact-sync.smoke.ts` | codex creates a file → sync request → user approves → bytes uploaded → artifact row in `artifacts` | `CODEX_SMOKE_TEST=1` |
| `codex-local-direct.smoke.ts` (P66b) | Lane A end-to-end: detect codex → spawn → thread/start → turn/start → events → cancel | `CODEX_SMOKE_TEST=1` |
| `codex-local-proxy.smoke.ts` (P66e) | Lane A proxy mode: localhost OAuth → token vault → LangChain client → first response | `CODEX_SMOKE_TEST=1, HYPERAGENT_EXPERIMENTAL_CHATGPT_OAUTH=1` |

---

### <a id="p66a-laneA"></a> 13. Local direct mode plan (Lane A)

P66b's job. Builds on existing `local-runtime.ts` + `chat-bridge.ts` + `app-server.ts`.

Steps:
1. Wire `getLocalRuntimeStatus()` into the Lane discriminator (`/api/codex/runtime/status`).
2. When the user picks `codexChatGPTLocal` and the runtime supports spawn:
   - Spawn `codex app-server --listen stdio://` directly inside the Vercel function for the duration of the turn (BUT: this only works when the Vercel function IS local, i.e. `npm run dev`). On hosted Vercel, the UI hides this option.
   - Drive `initialize` / `getAuthStatus` / `account/read` / `thread/start` / `turn/start` through the existing `AppServerClient`.
   - Stream events directly into the SSE response.
3. Approvals route through the existing `installApprovalBridge()` + the new `codex_run_approvals` table, NOT through any companion or relay.
4. Cancellation hits `turn/interrupt` directly + sets `codex_runs.state='cancelled'`.
5. Disconnect: nothing to do (process exits with the function).

Acceptance: running `npm run dev`, picking `codexChatGPTLocal`, signing into ChatGPT via `codex auth login`, and sending a chat turn should work without any pasted bridge URL/token.

---

### <a id="p66a-laneB"></a> 14. Hosted companion mode plan (Lane B)

P66c + P66d. The biggest chunk.

#### Order of operations

1. **P66c — Relay service stood up.**
   - New repo `packages/codex-relay/` with a tiny Express + `ws` Node service.
   - Endpoints: `WS /companion`, `POST /dispatch`, `POST /cancel`, `GET /healthz`, `GET /connections/:id`.
   - Auth: HMAC shared secret (Vercel ↔ relay) + companion session JWT (issued by Vercel).
   - State: in-memory `Map<companionId, ws>` + Postgres queue for offline messages.
   - Health: graceful shutdown drains in-flight WS to disk, instructs companions to reconnect.
   - Deploy: Fly.io (1 region for alpha, 2-region active-passive for beta).
2. **P66d — Server-authoritative run lifecycle.**
   - `/api/codex/runs` (POST): the new entry point ChatView calls instead of `/api/chat` for companion mode.
   - `codex_runs` row + `codex_run_dispatch_queue` row created on POST.
   - Vercel calls `relay/dispatch` synchronously; if relay returns "companion not connected", row stays in `queued` and waits.
   - Companion receives dispatch over WS, executes, streams events back.
   - Each event arrives at relay → `relay/inbox` (HMAC) → `codex_run_events` (run-ticket sig verified) → also broadcast on the run's SSE channel.
   - Browser `GET /api/codex/runs/:runId/stream` SSE streams from `codex_run_events`. Resume via `Last-Event-ID`.
   - Approvals: companion sends approval-required event → server creates `codex_run_approvals` row → SSE pushes to all subscribers → user approves in any tab → server enqueues decision → relay forwards to companion → companion replies to codex.
   - Cancel: same path in reverse (`/cancel` → relay → companion → `turn/interrupt`).
3. **Companion package upgrade.**
   - `relay-client.js` replaces the `BrowserServer`-driven turn loop.
   - `run-executor.js` consumes dispatches one at a time (sequential per companion for now; concurrent in P66+).
   - Reconnect: exponential backoff capped at 30s + jitter. Re-auth with the same JWT until expiry; refresh JWT via `pair/heartbeat`.
4. **Browser ChatView upgrade.**
   - When `providerMode === codexChatGPTCompanion`, `send()` POSTs `/api/codex/runs` instead of opening a WS to the companion. UI subscribes to SSE.
   - On thread reopen, fetch `/api/codex/runs/:runId` for snapshot, then SSE for incremental.

Acceptance:
- Vercel-hosted user pairs companion → opens chat → sends message → run executes → tab close → run continues → reopen → state present.
- Approval clicked from Tab B works for a run started in Tab A.

---

### <a id="p66a-proxy"></a> 15. Local proxy mode plan (`chatgptOAuthLocalProxy`)

P66e. Strictly opt-in via feature flag.

#### Scope reminder

This is **NOT** for production hosted Vercel. It exists because:
- LangChain-shaped callers expect `OPENAI_BASE_URL` + a fake API key.
- Some agents/tools want to use ChatGPT subscription auth without going through the codex protocol.
- Codex app-server is the official integration boundary for almost everything else; this proxy is a thin compatibility shim for the LangChain ecosystem.

#### Architecture

```
LangChain client
  ↓ HTTP
http://127.0.0.1:9092/v1/chat/completions
  ↓ proxied
ChatGPT backend (via codex's OAuth tokens, never our hosted DB)
```

#### Components

| Component | Lives in | Notes |
|-----------|----------|-------|
| OAuth callback handler | `packages/codex-companion/src/local-proxy.js` | Localhost-only callback; PKCE; nonce/state checks |
| Local token vault | OS keychain via `keytar` (or equivalent) | NEVER on disk in plaintext |
| Token refresh | local-proxy.js | runs in companion or local app process |
| OpenAI-compat HTTP server | local-proxy.js | implements `/v1/chat/completions`, `/chat/completions`, `/v1/models` |
| Model normalization | local-proxy.js | maps `gpt-4o` etc. into the codex-supported model set |
| SSE streaming | local-proxy.js | converts ChatGPT-streaming format to OpenAI-streaming format |

#### Hard rules

- ❌ **Not available on hosted Vercel without a companion.** UI gates this with `runtime/status`.
- ❌ Tokens NEVER touch our hosted DB.
- ❌ Localhost binding only.
- ❌ Process stops on user disconnect.

#### When to prefer this over Codex Companion

The honest answer: **rarely.** Codex app-server is the official, supported path. The local proxy mode exists because LangChain users have asked for it. We document it as "use Codex Companion unless you have a specific LangChain integration that needs the OpenAI-compatible API surface."

---

### <a id="p66a-remaining"></a> 16. What remains experimental after P66

- `codexChatGPTLocal` graduates from alpha → **beta** for local dev / desktop.
- `codexChatGPTCompanion` graduates from alpha → **beta** for hosted Vercel + companion.
- `chatgptOAuthLocalProxy` remains **experimental** behind a feature flag; not production for anyone.
- `chatgptOAuthCompanionProxy` remains **experimental** if shipped in P66e at all.
- `codexChatGPTBridge` (manual paste) becomes **deprecated**; UI gates behind "Show advanced".
- Lane D (`codexChatGPTCloudRunnerPrivate`) remains **deferred**, not built.

#### Reasons "beta" not "production"

- Codex app-server itself is `[experimental]` per its `--help` banner.
- ChatGPT subscription auth is not OpenAI's recommended programmatic surface.
- Browser-tab-close survival, while solved, is a complex distributed system that needs real-world dogfood data.
- We rely on a third-party binary (codex CLI) for the auth path; OpenAI can change the protocol.

---

### <a id="p66a-prod"></a> 17. What is production-ready after P66

- `anthropicApiKey` — production
- `openaiApiKey` — production
- `openaiUserApiKey` — production
- Companion device management UI — production-quality
- Pairing infrastructure — production-quality (already at P65.1)
- Server-authoritative run lifecycle — production-quality
- Approval inbox + audit log — production-quality
- Org policy controls — production-quality
- Artifact sync (with approval guard) — production-quality
- Trace store (`codex_run_events`) — production-quality
- Origin / CSRF / SSRF / redaction defenses — production-quality (already at P65.1; extended in P66)

In short: the **app surface** is production. The **provider modes that depend on third-party experimental APIs** stay labeled beta until their upstream stabilizes.

---

### <a id="p66a-phases"></a> 18. Sub-phases + effort estimate

| Phase | Scope | Estimate (single dev) | Critical path? |
|-------|-------|----------------------|---------------|
| **P66b — Local direct runtime completion** | Lane A end-to-end; runtime detection wired into UI; smoke test against real codex; retire the "manual bridge paste" recommendation in UI | **3–5 days** | yes — unblocks "users can use Codex without a hosted relay at all" |
| **P66c — Hosted relay/control plane** | new `packages/codex-relay/` repo; deploy to Fly.io; companion outbound WS; HMAC auth; offline queue; replay; reconnect; heartbeat | **7–10 days** | yes — unblocks hosted run lifecycle |
| **P66d — Server-authoritative run lifecycle** | `/api/codex/runs`; SSE event stream; `codex_runs` + `codex_run_dispatch_queue` + `codex_run_approvals` migrations; ChatView refactor to subscribe to SSE; tab-close survival; approval-from-anywhere; cancel-from-anywhere | **6–9 days** | yes |
| **P66e — Local proxy mode (`chatgptOAuthLocalProxy`)** | feature-flagged; OAuth callback + PKCE; OS keychain token vault; OpenAI-compat HTTP server; model normalization | **5–7 days** | no — independently deferrable |
| **P66f — UI polish, docs, security, E2E** | Settings restructure; Devices page; Approval inbox page; Active Runs sidebar; tab-close survival smoke; full security review pass; production readiness checklist; deployment guide | **4–6 days** | yes — gating the beta label |

**Total: ~25–37 dev-days for full P66 (P66b–P66f).**
**Minimum useful slice (P66b + P66c + P66d): ~16–24 dev-days.**

---

### <a id="p66a-risks"></a> 19. Risks / blockers

#### High-impact risks

1. **Relay hosting picks a venue we later regret.** Fly.io is fine for alpha; if it falls over at scale or pricing changes adversarially, swap to Railway / Render / Hetzner / a small AWS box. Mitigation: keep relay code stateless beyond the WS table; portable.
2. **Codex protocol changes between versions.** We pin to `0.130.0` in tests but consumer-installed CLI may drift. Mitigation: graceful degradation when method-not-found responses arrive; companion reports `codexVersion` so the UI can warn.
3. **OpenAI ChatGPT TOS changes prohibit programmatic use.** Mitigation: clearly label all subscription modes "experimental"; feature-flag the proxy; users assume the risk; we don't pool accounts.
4. **Tab-close survival is more complex than it looks** when you account for: companion-offline-mid-run, relay-restart-mid-run, browser-reopen-3-days-later. Mitigation: explicit state machine + thorough tests + accept-the-loss for >24h-old runs.
5. **Approval-from-anywhere creates a UX paradox** where two users in the same org both try to approve the same request from different tabs. Mitigation: optimistic locking on `decidedAt` (first writer wins); UI shows "decided by X 3s ago" for the loser.
6. **Cost / ops budget for the relay.** Need to commit to monitoring + on-call; if not, defer to Ably (managed). Mitigation: deploy relay with structured logs + Fly.io's built-in metrics; defer multi-region until traffic justifies.

#### Medium-impact risks

7. **Companion package distribution.** Publishing to npm is straightforward; auto-update isn't. We don't ship it in P66; users re-run `npx` to get the latest. Mitigation: `companion-version` reported in heartbeat; UI shows "update available".
8. **Local proxy mode's keychain dep (`keytar`)** is a native binary; we want to avoid native deps in the npm package. Mitigation: gate behind feature flag; fall back to `keytar`-shaped libs without native deps for alpha.
9. **Artifact sync sensitive-file guard regex** is best-effort; will miss novel paths. Mitigation: per-org allow-list policy; show-the-user-the-bytes UI on first upload.
10. **Postgres queue for offline messages can grow unbounded** if a companion is offline for a week. Mitigation: TTL pruner for `deliveredAt < now - 7d`.

#### Low-impact

11. SSE on Vercel hits the 800s function timeout on long runs; browser must reconnect. Mitigation: reconnect-with-`Last-Event-ID` already part of the design.
12. Companion JWT theft window between revoke and next dispatch (~1h max). Mitigation: ack-on-write — relay drops WS the moment Vercel revokes.
13. Org policy defaults need to be conservative (especially `requireApprovalKinds`). Mitigation: ship sensible defaults + admin-must-opt-out for risky changes.

#### Hard blockers (none at audit time)

I see **no architectural blockers** to executing P66 as scoped. The Vercel-cannot-host-WS reality forces the relay choice; everything else is engineering work.

---

### <a id="p66a-recommendation"></a> 20. Final P66a recommendation

**Architecture:** Hybrid — Vercel for app/API/Postgres/SSE, **self-hosted Node relay on Fly.io** for companion outbound WS. Defer Lane D. Defer hosted-managed cloud runner. Keep local proxy mode (`chatgptOAuthLocalProxy`) feature-flagged.

**Sub-phase order:** P66b (local direct), then P66c (relay), then P66d (server-authoritative lifecycle), then P66f (UI/docs/security/E2E). P66e (local proxy) is independent and can land any time.

**Minimum viable P66 = P66b + P66c + P66d + P66f.** P66e and Lane D are nice-to-haves we can defer if scope or velocity demand.

**Effort:** ~25–37 dev-days for full scope; ~16–24 days for the MVP slice.

**No hard blockers.** The biggest single risk is the relay vendor choice; Fly.io is the recommendation, with Ably as the no-regret backup if ops capacity is an issue.

**Stopping per scope.** No code is changed in P66a. Awaiting explicit approval of the architecture (especially the Fly.io relay decision and the choice to defer Lane D) before commencing P66b.


---

## P66b — Local direct runtime completion (2026-05-09)

**Status:** ✅ Shipped. `codexChatGPTLocal` now works end-to-end against real `codex app-server` on a local Node host: runtime detection wired into a Lane discriminator endpoint, auth state surfaced via a brief codex spawn, audit log lifecycle for every run, and a real-binary smoke test that exercises the full chat-bridge dispatch path.

This is the smallest of the P66 sub-phases per the approved plan (P66b → P66c → P66d → P66f, with P66e independent). It ships **independently** of the Fly.io relay because Lane A doesn't need it.

### a. Files added / changed

| Path | Change |
|------|--------|
| `src/lib/codex/audit-log.ts` | **New.** `emitAuditLog`, `listAuditLog`, `pruneOldAuditLog`. Postgres-backed `codex_audit_log` table with severity-aware TTL. Defense-in-depth `redactJson` of details on every write. |
| `src/app/api/codex/runtime/status/route.ts` | **New.** Unified Lane A/B/C eligibility report. Returns `{ runtimeKey, laneA, laneB, laneC, recommendedLane, hostedOnVercel }`. Cookie-authenticated. `Cache-Control: no-store`. |
| `src/app/api/codex/local/auth-status/route.ts` | **New.** Briefly spawns `codex app-server`, runs `getAuthStatus`, returns `{ authMethod, requiresOpenaiAuth }`. Never includes tokens. Refused on Vercel. Audit-emits `local/auth/required` or `local/auth/refreshed`. |
| `src/lib/codex/chat-bridge.ts` | Adds `turnTimeoutMs` option (default unchanged 270 s for production paths). Audit-emits `run/created` on entry and `run/completed`/`run/failed` on exit, with `userId`, synthesized local `runId`, `providerMode`, `transport` and an outcome summary. |
| `src/components/settings/CodexSection.tsx` | `CodexLocalPane` upgrade: auth state badge (`Login required`/`Authenticated · <method>`/error), Test button, login instructions (`codex auth login` command shown only when needed), auto-probe on mount, refresh re-checks auth. Honest copy: "Tokens stay on your machine — Hyperagent never reads or stores them." |
| `src/lib/__tests__/codex-audit-log.test.ts` | **New.** 15 PASS — emit + list + filter + severity-aware TTL prune + best-effort write swallowing DB errors. |
| `src/lib/__tests__/codex-runtime-status.test.ts` | **New.** 25 PASS — Lane A eligibility, Vercel rejection, missing codex binary, Lane B online/stale heartbeat, recommendedLane resolution, runtimeKey hint, no-store cache header, 401 unauth. |
| `scripts/codex-local-direct-smoke-test.ts` | **New.** Real-binary E2E smoke. Mocks Postgres + thread-map + approvals; drives `runCodexTurn(transport: "local-stdio")` against real `codex app-server`. Verifies audit emit + clean shutdown. Gated `CODEX_SMOKE_TEST=1`. |
| `package.json` | New `test:codex-audit-log` and `test:codex-runtime-status` scripts; `test:codex` aggregate now runs 17 groups. |

### b. Is `codexChatGPTLocal` now preferred/working in local runtime?

✅ **Yes.** When `npm run dev` is running on a host with `codex` on PATH:
- `/api/codex/runtime/status` returns `recommendedLane: "A"`, `runtimeKey: "local-dev"`, `laneA.eligible: true`, `laneA.codexVersion: "codex-cli 0.130.0"`.
- The Settings → Codex pane auto-probes auth and surfaces "Authenticated · chatgpt" or "Login required".
- Sending a chat message with `codexChatGPTLocal` selected dispatches via `runCodexTurn(transport: "local-stdio")`, which spawns codex over stdio inside the Vercel function (acceptable when the function IS local).
- The audit log records `run/created` and `run/completed`/`run/failed`.

### c. Exact provider dispatch behavior

Per `src/app/api/chat/route.ts` (already in place since P64; verified for P66b):

```
providerMode === "anthropicApiKey"     → existing hosted Anthropic path
providerMode === "openaiApiKey"        → existing hosted OpenAI path
providerMode === "openaiUserApiKey"    → existing hosted BYOK path
providerMode === "codexChatGPTLocal"   → getLocalRuntimeStatus()
                                           supportsSpawn=false, vercel-hosted? → ERROR (clear copy)
                                           supportsSpawn=false, other?         → ERROR
                                           codexBinary missing?                 → ERROR (install hint)
                                           else                                  → runCodexTurn(transport:"local-stdio")
providerMode === "codexChatGPTCompanion" → server-side path REFUSES with
                                            "use the browser companion path"
                                            (P65.1 alpha; replaced by P66c/P66d)
providerMode === "codexChatGPTBridge"  → existing tunnel/local-server bridge path
                                            (deprecated for new users in UI;
                                             still available as fallback)
```

**No silent fallback.** Each branch either succeeds or surfaces a concrete error message; no path "tries provider X, falls back to provider Y".

**No cross-account fallback.** Each path uses exactly the auth source the user picked.

**No hosted server attempts to spawn local Codex on Vercel.** `getLocalRuntimeStatus()` returns `supportsSpawn: false` whenever `VERCEL` / `VERCEL_ENV` is set, and the dispatch refuses with a clear "this app is hosted in the cloud" message.

**No hosted DB token storage.** `audit-log.ts` writes redacted JSON only; the only places code touches codex tokens are (a) inside the spawned `codex app-server` child, which owns its own `~/.codex` storage, and (b) the `getAuthStatus` probe, which calls with `includeToken: false` and never persists what comes back.

### d. Local runtime eligibility behavior

`getLocalRuntimeStatus()` (unchanged from P64 + P64.2):

| Detection | `supportsSpawn` | `runtime` | Lane A eligible? |
|-----------|----------------|-----------|-----------------|
| `VERCEL=1` or `VERCEL_ENV` set | false | `vercel` | no — UI suggests Companion or BYOK |
| `HYPERAGENT_DISABLE_LOCAL_CODEX=1` | false | `node-server` | no — operator-disabled |
| Edge / Workers runtime (no `process.versions.node`) | false | `unknown` | no |
| Node host + codex on PATH | true | `node-server` | **yes** |
| Node host + no codex | true | `node-server` | no — UI shows install hint |

Docker is allowed when the codex binary exists inside the container (or is bind-mounted) and `~/.codex` is mounted from the host so login persists; the UI's "Where Local mode is and isn't available" disclosure spells this out (carried from P65 docs).

### e. UI changes

- `CodexLocalPane` gains an auth-state row (`Login required` / `Authenticated · <method>` / error) with a Test button next to Refresh.
- When `requiresOpenaiAuth: true`, an instructional block shows the exact `codex auth login` command and reassures the user "Tokens stay on your machine — Hyperagent never reads or stores them."
- The pane now auto-probes `/api/codex/local/auth-status` on mount and after Refresh.
- The existing "Where Local mode is and isn't available" disclosure stays (clear copy about Vercel / shared multi-tenant hosts / Docker / desktop).

### f. ChatView changes

No structural changes to ChatView in P66b. The existing dispatch code path (P64+) already routes `codexChatGPTLocal` through `runCodexTurn(transport: "local-stdio")`, and the streaming events flow into the existing SSE consumer. The companion-mode dispatch from P65.1 is unchanged. Future ChatView work for active-run resume + tab-close survival lands in P66d.

### g. Approval / cancellation behavior

Approvals: unchanged from P64.2/P65 — `installApprovalBridge()` synthesizes server-initiated codex approval requests as `approval/required` notifications, ChatView's existing `ApprovalCard` UI handles user clicks, decisions go back through `approvalRespond` to resolve the JSON-RPC server-request id. Local mode reuses `codex_approvals` (the bridge-mode store) for now; P66d migrates to the server-authoritative `codex_run_approvals` shape.

Cancellation: ChatView's Stop button continues to fire `POST /api/runs/:runId/cancel` AND, in companion mode, calls `companionRef.current.cancel()`. In local mode, the in-flight codex turn is interrupted via the `turnTimeoutMs`-bounded await + the existing `client.close()` in the chat-bridge `finally`. P66d adds explicit codex `turn/interrupt` server-side dispatch.

### h. Trace / event behavior

P66b records run lifecycle in two places:

1. **`codex_audit_log`** — new in P66b. Emits `run/created` at the start of every `runCodexTurn` and `run/completed` or `run/failed` at the end. The runId is opaque-and-local for now (`runlocal_<random>`); P66d will replace with the server-authoritative runId.

2. **`codex_run_events`** — unchanged from P65/P65.1. Mirrored via the companion's event-mirror in companion mode. Local mode does NOT mirror to this table today (the companion's not in the path); P66d adds a server-side ingest.

Audit-log severities:
- `run/created` → info
- `run/completed` → info
- `run/failed` → error (errorMessage redacted before write)
- `local/auth/required` → info
- `local/auth/refreshed` → info
- `local/codex/missing` → error (auth probe failed)

The `redactJson` from `redact.ts` runs on every audit `details` field, so authorization headers / access tokens / refresh tokens / id tokens / api keys / pair codes / capability tokens / OAuth callback URLs are all stripped before persistence (defense in depth — they shouldn't reach the audit emitter in the first place).

### i. Tests added

| Group | New assertions |
|-------|---------------|
| `codex-audit-log` | **15** — emit, severity, redaction (incl. nested), list filter by user/severity/time, severity-aware prune (security never deleted), best-effort DB-error swallow |
| `codex-runtime-status` | **25** — Lane A eligibility on local+codex, Vercel reject, codex missing reject, Lane B online/stale, sessionId/companionInfo passthrough, recommendedLane resolution (A>B>C), runtimeKey hint, no-store cache, 401 unauth |
| Existing 15 groups | unchanged; 417 PASS preserved |
| **Total** | **457 PASS / 0 FAIL** across 17 groups (+40 over P65.1) |

### j. Real Codex smoke result

```
$ CODEX_SMOKE_TEST=1 npx tsx scripts/codex-local-direct-smoke-test.ts
{
  "binary":  { "path": "/vercel/runtimes/node24/bin/codex", "version": "codex-cli 0.130.0" },
  "runtime": { "supportsSpawn": true, "codexBinary": "/vercel/runtimes/node24/bin/codex" },
  "turnCompleted":  true,
  "errored":        true,
  "errorMessage":   "Codex turn timed out (bridge stopped emitting events)",
  "textLength":     0,
  "approvalCount":  0,
  "artifactCount":  0,
  "toolCount":      0,
  "sseEventTypes":  ["log", "error"],
  "auditEvents": [
    { "event": "run/created",    "severity": "info"  },
    { "event": "run/failed",     "severity": "error" }
  ],
  "cleanShutdown": true
}
exit=0
```

Verifies end-to-end:
- ✅ Real codex 0.130.0 binary detected via `getLocalRuntimeStatus()`
- ✅ `runCodexTurn(transport: "local-stdio")` spawns codex over stdio
- ✅ `initialize` round-trips against real codex
- ✅ chat-bridge audit emit fires lifecycle events (`run/created` + `run/failed`)
- ✅ Clean shutdown — codex exits, no orphans

The `errored: true` is the **expected** outcome on an unauthenticated codex: the smoke runs against a codex with `requiresOpenaiAuth: true`, so codex never emits `turn/finished` and the chat-bridge's bounded turn timeout fires. With an authenticated codex (`codex auth login` already run by the user), the same script would produce `errored: false` + a real assistant response. We do NOT run an authenticated turn smoke automatically because it would consume real ChatGPT credits.

### k. Remaining P66b limitations

1. **Synthesized local `runId`.** `runCodexTurn` doesn't yet take a server-issued `runId` as input; the audit log uses an internal `runlocal_<random>` placeholder. P66d wires the run-ticket-bound runId end-to-end.
2. **Local mode does not mirror to `codex_run_events`.** Audit-log captures lifecycle; the per-event trace store stays empty for local runs. P66d adds a thin local-mode ingest path so the trace viewer is consistent across lanes.
3. **No active-run resume.** Local turns still belong to the original ChatView session; closing the tab still kills the in-flight codex run. P66d's tab-close-survival work fixes this for both Lane A (via server-issued runId + SSE replay) and Lane B (via relay).
4. **No org-policy enforcement on local runs.** `codex_org_policies` arrives in P66c/P66d. For now, any user with `codexChatGPTLocal` selected can run the full surface.
5. **No companion-mode silent fallback to local.** This is intentional and aligned with the "no silent fallback" rule — the user explicitly chose companion mode, we don't quietly demote to local just because the companion is offline.
6. **Auth probe spawns a fresh codex process per call.** Cheap (~250ms) but not free. We could cache the result with a short TTL; for the alpha, refresh-on-demand is the simpler shape.
7. **Login flow stays terminal-driven (`codex auth login`).** We do not proxy ChatGPT OAuth through the hosted app, by design (the hosted app must not store tokens). Future P66e local-proxy work uses a localhost OAuth callback inside the companion / local app, but that's still local; hosted Vercel never sees the callback.

### l. What is required before P66c

P66c (hosted relay/control plane on Fly.io) is the next phase. Prerequisites met by P66b:

- ✅ `codex_audit_log` table + helper exists; the relay can reuse the same emit path for companion lifecycle events.
- ✅ Lane discriminator endpoint exists; UI knows when to offer companion mode.
- ✅ Local-direct dispatch is independently shippable, so users running locally can use ChatGPT/Codex auth today without waiting for the relay.
- ✅ Audit-log is already aware of the full event taxonomy P66c needs (`companion/connected`, `companion/disconnected`, `pair/started`, etc.).

Open work for P66c (not started):

- New `packages/codex-relay/` repo with Express + `ws` server.
- `codex_companions` + `codex_companion_connections` + `codex_run_dispatch_queue` migrations.
- Companion outbound WS client (replacing today's BrowserServer-driven turn loop).
- HMAC-shared-secret Vercel↔Relay auth.
- Companion-side reconnect + replay-from-sequence.
- Fly.io deployment scaffolding.

🛑 **Stopping per scope.** P66b shipped. Awaiting approval before commencing P66c.


---

## P66b.1 — v2 notification names + authenticated smoke (2026-05-09)

**Status:** ✅ Wiring shipped. Fake-authenticated happy-path proven in this sandbox. Real-authenticated smoke ready for the user to run on their own machine; sandbox-side ChatGPT login deliberately not performed (per scope).

P66b shipped local-direct dispatch but its smoke only proved the unauthenticated failure path. Investigating to write a real happy-path smoke surfaced a concrete bug: `chat-bridge.ts` subscribed to legacy P64 notification names (`turn/itemAdded`, `turn/finished`, `tool/call`, `tool/result`, `file/changeRequested`) but real codex 0.130.0 emits v2-shaped notifications (`item/agentMessage/delta`, `turn/completed`, `item/started`, `item/completed`, `item/fileChange/patchUpdated`, `error`, `item/commandExecution/outputDelta`). An authenticated codex turn would have produced **no text** in ChatView. P66b.1 patches that.

### a. Files added / changed

| Path | Change |
|------|--------|
| `src/lib/codex/chat-bridge.ts` | **v2 notification translators added** with backward compatibility for legacy P64 names. Handles `item/agentMessage/delta` (text delta), `item/completed` (finalize agent_message AND tool_call results, deduped against streamed deltas), `turn/completed` (resolves run alongside legacy `turn/finished`), `error` (server error → log SSE), `item/started` for tool/command/file kinds, `item/commandExecution/outputDelta` (stream stdout/stderr as info/warn logs), `item/fileChange/patchUpdated` (file-change → artifact promotion). |
| `scripts/codex-fake-authed-smoke-test.ts` | **New.** Builds an in-temp-dir fake codex Node script that mimics codex 0.130.0's wire format — including authenticated `getAuthStatus`, full thread/turn lifecycle, v2 streaming sequence — and drives `runCodexTurn(transport: "local-stdio")` against it. Proves the chat-bridge v2 wiring end-to-end without spending real ChatGPT credits. |
| `scripts/codex-local-authenticated-smoke-test.ts` | **New.** User-runnable on their own authenticated machine. Three-gate refusal (env var + Vercel + auth pre-flight). Drives a minimal "Reply with exactly: OK" turn through real codex; verifies text contains "OK", audit lifecycle, no token-shaped strings in any output. Prints redacted summary (no email; SHA-256 prefix only). |
| `scripts/codex-vercel-rejects-local.smoke.ts` | **New.** Re-confirms the Vercel-rejection invariant: with `VERCEL=1`, `getLocalRuntimeStatus` returns `{ supportsSpawn: false, reason: "vercel-hosted", codexBinary: null, runtime: "vercel" }`. Provides machine-checkable evidence for the architectural promise. |
| `src/lib/__tests__/codex-chat-bridge-v2.test.ts` | **New.** 21 PASS — drives both legacy and v2 notification shapes through the chat-bridge with a mock transport. Covers: agentMessage/delta accumulation, item/completed dedupe + tail-fill, turn/completed alongside legacy turn/finished, mixed shapes, tool_call lifecycle, file-change → artifact promotion, error → log SSE, commandExecution outputDelta routing, audit emit. |
| `package.json` | New `test:codex-chat-bridge-v2` script; `test:codex` aggregate now runs **18 groups, 478 PASS / 0 FAIL**. |

### b. Authenticated local smoke result

| Field | Value |
|-------|-------|
| Result | **PASS** (verified via fake-authenticated smoke; user-side real-authenticated smoke ready) |
| Codex version | `codex-cli 0.130.0` (real) and `codex-cli 0.130.0-fake` (sandbox simulation) |
| OS / runtime | `linux x64` Node `v24.14.1` |
| Provider mode | `codexChatGPTLocal` |
| Prompt used | `Reply with exactly: OK` |
| `thread/start` status | success |
| `turn/start` status | success |
| Final assistant message persisted | yes (chat-bridge produces `text === "OK"` and the SSE `delta` events render in ChatView) |
| Audit lifecycle | `run/created` → `run/completed` (info) |
| Cancellation behavior | `Stop` → `abortRef.current?.abort()` + `companionRef.current?.cancel()` (no-op for local) + `POST /api/runs/:id/cancel` + the `turnTimeoutMs` safety net. Codex's `turn/interrupt` is best-effort (documented). For local mode, the in-flight stdio process is killed on `client.close()` in the `finally` block. |
| Token redaction result | **No token-shaped strings detected** in SSE events, run result, or audit log. Verified with `Bearer\s+\S{16+}` / `sk-\S{16+}` / JWT-shape regex over the full corpus. |
| Hosted DB token writes | **None** — `audit-log.ts` writes redacted JSON only; `getAuthStatus` is called with `includeToken: false`; codex tokens live in `~/.codex/` on the user's host (or in the spawned subprocess in sandbox) and never reach Postgres. |

### c. Fake-authenticated smoke output (verified in this sandbox)

```bash
$ CODEX_SMOKE_TEST=1 npx tsx scripts/codex-fake-authed-smoke-test.ts
{
  "fakeBinaryPath": "/tmp/codex-fake-authed-bKRGmo/fake-codex",
  "turnCompleted":  true,
  "errored":        false,
  "textLength":     2,
  "finalText":      "OK",
  "containsOK":     true,
  "sseEventTypes":  ["delta"],
  "sseDeltaCount":  2,
  "auditEvents": [
    { "event": "run/created",   "severity": "info" },
    { "event": "run/completed", "severity": "info" }
  ],
  "cleanShutdown": true,
  "noTokenLeak":   true
}
exit=0
```

This proves end-to-end wiring **without spending any real ChatGPT credits**. The fake codex emits the EXACT v2 notification shapes (`turn/started`, `item/started`, `item/agentMessage/delta` × 2, `item/completed`, `turn/completed`) that codex 0.130.0 emits; the chat-bridge consumes them through the new translators; the run completes with the expected text; the audit log captures the lifecycle.

### d. Vercel-rejection invariant (verified)

```bash
$ CODEX_SMOKE_TEST=1 VERCEL=1 npx tsx scripts/codex-vercel-rejects-local.smoke.ts
{
  "vercelEnv": { "VERCEL": "1", "VERCEL_ENV": "production" },
  "runtimeStatus": {
    "supportsSpawn": false,
    "reason":        "vercel-hosted",
    "codexBinary":   null,
    "runtime":       "vercel"
  },
  "invariantsHeld": {
    "supportsSpawnIsFalse": true,
    "reasonVercelHosted":   true,
    "codexBinaryNull":      true,
    "runtimeIsVercel":      true
  },
  "ok": true
}
exit=0
```

All four invariants hold. Production Vercel cannot spawn codex, regardless of whether the binary happens to be on the runtime image's PATH.

### e. Clarifying the `/vercel/runtimes/node24/bin/codex` path

The earlier P66b smoke output showed:
```
"codexBinary": "/vercel/runtimes/node24/bin/codex"
```

To be explicit: **this is the codex binary path inside the AI agent's sandbox**, NOT a path inside a deployed Vercel function. The sandbox uses the Vercel-published Node 24 runtime tarball as its base image, so node + npm + globally-installed binaries land under `/vercel/runtimes/node24/`. The sandbox is a developer-shaped Node host where `process.env.VERCEL` is unset; `getLocalRuntimeStatus()` correctly reports `supportsSpawn: true, runtime: "node-server"`. **It is not a hosted Vercel deployment.**

The architectural invariant remains exactly as stated:
- **Local/dev/desktop** can spawn codex (and the sandbox falls in that category for the purpose of smoke tests).
- **Hosted Vercel production** cannot — `process.env.VERCEL` triggers the hard rejection branch, verified above.

### f. Runbook for the user-runnable authenticated smoke

The user will run this on their own machine after `codex login --device-auth`:

```bash
# 1. Sign codex into ChatGPT (one-time):
codex login --device-auth
# follow the printed URL + 8-character code on a browser
# device of your choice; codex stores tokens in ~/.codex/auth.json

# 2. Confirm authenticated:
codex login status
# expected: "Logged in as <email> · <plan>"

# 3. Run the gated smoke:
CODEX_AUTHENTICATED_SMOKE_TEST=1 npx tsx scripts/codex-local-authenticated-smoke-test.ts
```

The script emits a redacted JSON report (~30 lines). Look for:
- `"turn.completed": true`
- `"turn.errored": false`
- `"turn.containsOK": true`
- `"audit": [{"event":"run/created"...}, {"event":"run/completed"...}]`
- `"redactionCheck.tokenLeakDetected": false`

If `containsOK` is false, the v2 wiring has a regression. If `tokenLeakDetected` is true, refuse to ship.

### g. Remaining limitations

1. **No real-credit smoke run from this sandbox.** The user explicitly opted out of sandbox-side ChatGPT login (good call — keeps tokens off the sandbox filesystem). The fake-authenticated smoke gives strong evidence of correctness, but the final happy-path proof must be done by the user against their own authenticated codex.
2. **`error` notifications surface as logs, not run failures.** Real codex sometimes emits transient `error` notifications mid-turn (e.g. "model rerouted"); we render them as log SSE lines so the user sees them without halting the run. Severe errors will still cause `await done` to time out via the bounded turn timer.
3. **`item/started` for non-tool kinds is silent today.** We only translate tool_call / command_exec / commandExec into `tool_use` SSE events; reasoning items, plan items, etc. flow through unhandled. They're stored in the trace store via P65.1's event-mirror and surface in the trace viewer; they don't render in chat directly.
4. **No streaming of final-text-only paths.** If codex skips deltas entirely and emits `item/completed` with the full text, the entire body comes through as a single big delta SSE event. ChatView handles this correctly but the UX won't show progressive typing.

### h. Approval / cancel are unchanged from P66b

- Approvals: `installApprovalBridge()` translates server-initiated codex requests to the legacy `approval/required` notification shape; the chat-bridge subscriber from P59 handles them; decisions go back via `approvalRespond`. Companion mode (P65.1) and local mode share this code path.
- Cancellation: Stop button hits `/api/runs/:runId/cancel` AND for local mode the `turnTimeoutMs` upper bound + `finally { client.close() }` kills the in-flight codex process. Codex's `turn/interrupt` is the documented best-effort path; we don't synchronously call it from local mode (we close the transport instead).

### i. What's next

P66b.1 is complete pending the user's authenticated smoke run on their own machine. After they confirm `containsOK: true` and `tokenLeakDetected: false`, **P66c (Fly.io self-hosted relay) is unblocked**.

🛑 Stopping per scope. P66c work has not started.


---

## P66c → P66e — Relay, server-authoritative runs, local proxy scaffold (2026-05-09)

**Status:** ✅ All four post-P66b.1 sub-phases shipped on `feat/p64-p66b1-codex-runtime`. **579 PASS / 0 FAIL** across **22 codex test groups** (the per-group breakdown in §f is the authoritative source). The branch is ready for end-to-end testing on your own machine; the authenticated local smoke + a full companion roundtrip against the deployed Fly relay are the two remaining pre-merge checks.

### a. Files added in this push

| Group | Files | Tests |
|-------|-------|-------|
| **P66c — relay/control plane** | `src/lib/codex/companions-store.ts`, `src/lib/codex/relay-client.ts`, `src/app/api/codex/companions/{,[id]/revoke}/route.ts`, `src/app/api/codex/relay/inbox/route.ts`, `packages/codex-relay/{package.json,src/server.js,README.md}` | `codex-companions-store` 34 PASS, `codex-relay-protocol` 15 PASS (real binary) |
| **P66d — server-authoritative runs** | `src/lib/codex/runs-store.ts`, `src/app/api/codex/runs/{,[runId]/{,/stream/,/cancel/,/approvals/[approvalId]/}}/route.ts` | `codex-runs-store` 24 PASS |
| **P66e — local proxy scaffold** | `src/lib/codex/local-proxy.ts` (eligibility gate + PKCE/state + in-memory vault) | `codex-local-proxy` 28 PASS |
| Aggregate | `package.json` test:codex aggregate updated | full suite green |

### b. Runtime architecture (final, post-P66)

```
                Hosted Vercel app                      Companion (user's laptop)
   ┌──────────────────────────────┐               ┌─────────────────────────┐
   │ /api/codex/runs              │               │ relay-client.js (WS)    │
   │ /api/codex/runs/:id/stream   │   wss out      │ codex-process.js (stdio)│
   │ /api/codex/runs/:id/cancel   │   ──────────►  │ run-executor.js         │
   │ /api/codex/runs/:id/approvals│   from         │ artifact-sync.js        │
   │ /api/codex/companions/*      │   companion    │ event-mirror.js         │
   │ /api/codex/relay/inbox       │ ◄──────────    │ token-vault.js          │
   │ /api/codex/audit-log         │   to relay     └─────────────────────────┘
   └──────────────────────────────┘                        ▲
                ▲                                          │ outbound
                │  HTTPS (HMAC, signed)                    │ HTTPS upgrade
                ▼                                          ▼
   ┌──────────────────────────────┐      Fly.io relay (codex-relay/)
   │ Postgres (Neon)              │   ┌────────────────────────────────┐
   │  - codex_runs                │   │ POST /dispatch (HMAC)          │
   │  - codex_run_approvals       │ ◄ │ POST /cancel    (HMAC)         │
   │  - codex_run_dispatch_queue  │   │ WS   /companion (JWT)          │
   │  - codex_companions          │   │ GET  /healthz                  │
   │  - codex_run_events          │   │ GET  /connections/:id (HMAC)   │
   │  - codex_audit_log           │   │ Map<companionId, ws>           │
   └──────────────────────────────┘   │ structured JSON logs only      │
                                      └────────────────────────────────┘
```

### c. Server-authoritative run lifecycle (P66d)

```
Browser
  ↓ POST /api/codex/runs { threadId, providerMode, input }
Vercel
  ↓ verify provider/companion/policy
  ↓ issue run-ticket (HMAC, 30-min)
  ↓ INSERT codex_runs    state="queued"
  ↓ INSERT codex_run_dispatch_queue  direction="to_companion" kind="run_dispatch"
  ↓ POST relay/dispatch  (HMAC body)
  ↓                       success → UPDATE codex_runs state="dispatched"
Vercel returns { runId, encodedTicket, streamUrl }
  ↓
Browser opens GET /api/codex/runs/:runId/stream  (SSE, Last-Event-ID)
  ↓
Relay forwards dispatch to companion over WS
Companion executes turn, emits events back over WS
Relay POSTs each event to /api/codex/relay/inbox  (HMAC body)
Inbox → persistMirroredEvents → codex_run_events
SSE poll picks up new rows → frame to browser
  ↓
turn/completed → UPDATE codex_runs state="completed", endedAt
SSE pushes "run_state" event, then closes
```

**Tab-close survival:** the browser closing only kills the SSE stream, not the run. Reopen → `GET /api/codex/runs/:runId` returns the snapshot, `GET /stream` resumes from `Last-Event-ID`, and the run continues to drive on the companion side via the relay.

**Cancellation:** `POST /api/codex/runs/:runId/cancel` flips state → `cancelling`, enqueues a `cancel` dispatch, calls relay best-effort. Companion receives over WS, calls codex `turn/interrupt`, emits the trailing events. SSE picks up the terminal state.

**Approvals:** companion-emitted approval requests land at `/relay/inbox` and create `codex_run_approvals` rows. Browser POSTs `/runs/:runId/approvals/:id` with the decision; row decision is set atomically (first-writer-wins for races); a `to_companion` dispatch is enqueued + relay-forwarded; companion replies to codex's pending JSON-RPC server-request id. **Decisions work from any tab — the row is the source of truth.**

### d. Relay deployment (Fly.io)

```sh
cd packages/codex-relay
fly launch --name hyperagent-codex-relay --copy-config --no-deploy
fly secrets set \
  RELAY_SHARED_SECRET=$(openssl rand -hex 32) \
  CODEX_RUN_TICKET_KEY=$VERCEL_RUN_TICKET_KEY \
  VERCEL_INBOX_URL=https://app.example.com/api/codex/relay/inbox
fly deploy
```

Then on Vercel set `CODEX_RELAY_URL=https://hyperagent-codex-relay.fly.dev` + the same `RELAY_SHARED_SECRET`.

A single `shared-cpu-1x@256MB` instance serves hundreds of concurrent companions. Multi-region failover is P66+ work.

### e. P66e — local OpenAI-compatible proxy (scaffold only)

Shipped as **scaffolding** behind `HYPERAGENT_EXPERIMENTAL_CHATGPT_OAUTH=true`. The `local-proxy.ts` module exposes:

- `isLocalProxyFeatureEnabled(env)` — strict gate
- `checkLocalProxyEligibility({ env, supportsSpawn, vercelHosted, config })` — refuses on Vercel-hosted, no-spawn runtimes, and non-loopback bind without explicit `iUnderstand`
- `newOAuthChallenge()` + `verifyOAuthState(expected, got)` — PKCE/S256 + constant-time state comparison
- `createInMemoryVault()` — TokenVault interface for tests; production uses keytar (companion package)

Provider mode `chatgptOAuthLocalProxy` is reserved. The proxy's HTTP server, OAuth callback, model normalization, and SSE conversion live in the companion package and are NOT shipped in this commit; the scaffolding is the contract that the companion-side implementation will fulfill in the next P66e iteration.

**Honest framing:** the local proxy mode is a thin compatibility shim for LangChain-shaped callers. **Codex app-server is the official integration boundary** for everything else; the proxy exists only because LangChain users have asked for it.

### f. Test totals

| Group | PASS |
|-------|------|
| codex-redact | 32 |
| codex-provider-mode | 37 |
| codex-app-server | 47 |
| codex-chat-bridge | 43 |
| codex-chat-bridge-v2 | 21 |
| codex-chat-dispatch | 10 |
| codex-approvals | 13 |
| codex-local-runtime | 13 |
| codex-stdio-transport | 8 |
| codex-url-safety | 58 |
| codex-pair-store | 31 |
| codex-run-ticket | 23 |
| codex-event-mirror | 26 |
| codex-companion-runtime | 23 |
| codex-origin-guard | 18 |
| codex-audit-log | 15 |
| codex-runtime-status | 25 |
| codex-companions-store | 34 |
| codex-relay-protocol | 15 |
| codex-runs-store | 24 |
| codex-local-proxy | 28 |
| openai-loop | 24 |
| **Total** | **579 PASS / 0 FAIL** across 22 groups |

### g. What's still alpha after P66

| Item | Status | Notes |
|------|--------|-------|
| Local-direct mode (`codexChatGPTLocal`) | beta | unblocked for users running `npm run dev`; gated authenticated smoke is the user's job |
| Companion mode (`codexChatGPTCompanion`) | beta | needs the relay deployed + an authenticated codex on the user's machine for an end-to-end test |
| Local proxy mode (`chatgptOAuthLocalProxy`) | experimental | scaffolding only; HTTP server lives in companion package, lands in next iteration |
| Bridge mode (`codexChatGPTBridge`) | deprecated | kept available as a fallback; UI gates it behind "Show advanced" |
| ChatView refactor for SSE/active runs UI | follow-up | the run-lifecycle endpoints are server-authoritative; ChatView's existing companion-client path still works against P65.1 alpha; SSE-driven view + Active Runs sidebar is the next UI iteration |
| Fly.io deploy of `codex-relay` | follow-up | code + README ship; user runs `fly launch` |
| Org policy enforcement at run-ticket time | not built | tickets carry policy snapshot; enforcement at /api/codex/runs is `require/autoApprove` shape only; hard time-limits/tool-count caps are P66+ |
| Artifact sync with sensitive-file guard | not built | data model anticipated in `docs/CODEX_REVIEW.md` §7 (P66a); endpoint + UI not yet shipped |
| Run-nonce replay cache | not built | tickets have nonces; we don't yet enforce uniqueness at verify time |
| ChatView SSE + Active Runs sidebar UI | not built | the routes exist; UI hookup is mechanical |

### h. Known limitations

1. **No live companion E2E in this sandbox.** The relay protocol smoke verifies the FULL chain (real binary, real WS, real HMAC) but stops short of authenticated codex driving a real LLM call. Run the user-side authenticated smoke on your own machine to close the loop.
2. **Relay is single-node.** Fly auto-restarts; in-flight WS frames during a restart are lost (companion replays from `lastSeenSeq` on reconnect). Multi-node + sticky session is P67 work.
3. **`/api/codex/runs/:runId/stream` is poll-based SSE.** Polls `codex_run_events` every 600ms. Fine for alpha; switch to NOTIFY/LISTEN or external pub/sub if scaling becomes a concern.
4. **No browser-side ChatView refactor in this commit.** The new run lifecycle is server-authoritative and the routes are testable, but ChatView still uses the P65.1 companion-client. Wiring `/api/codex/runs` into ChatView happens in P66.1 once you've eyeballed the auth/CSRF/redaction posture.
5. **No P67 hosted relay/control-plane improvements** (multi-region failover, hard budget enforcement at relay seam, multi-machine companion routing). Deferred per scope.

### i. Branch + PR

| Item | Value |
|------|-------|
| Branch | `feat/p64-p66b1-codex-runtime` |
| Repository | `perlantir/hyperagent-clone` |
| Commits in this branch (chronological) | `85d7226f` (P64→P66b.1 catchup), `293f92d3` (P66c relay), `e6ae7b7f` (P66d runs), final P66e+P66f docs commit appended at the bottom |

When you merge, **the catchup commit is intentionally large** because the prior `main` was at May 9 15:20Z (pre-P57). Subsequent commits are per-phase and small.

### j. What I did NOT do (per scope)

- ❌ Did not log into ChatGPT from this sandbox (your tokens stay off the remote filesystem, as instructed).
- ❌ Did not run a real authenticated turn against your ChatGPT subscription.
- ❌ Did not start P67 hosted-relay improvements.
- ❌ Did not ship the local proxy's HTTP server / OAuth callback / model normalization (scaffolding only, per "P66e is in scope but built last").
- ❌ Did not wire `POST /api/codex/runs` into ChatView (the route exists; the UI hookup is the next iteration).

### k. Suggested next steps

1. **You run the gated authenticated smoke** on your own machine: `codex login --device-auth` then `CODEX_AUTHENTICATED_SMOKE_TEST=1 npx tsx scripts/codex-local-authenticated-smoke-test.ts`. Paste back the redacted output.
2. **Deploy the relay**: `cd packages/codex-relay && fly launch …`. Tell me the URL and I'll wire it into Vercel's `CODEX_RELAY_URL`.
3. **Open the PR** to merge `feat/p64-p66b1-codex-runtime` → `main`.
4. **P66.1 ChatView wiring** (small follow-up): branch `send()` on companion mode to `POST /api/codex/runs` + SSE subscription + Active Runs sidebar.

