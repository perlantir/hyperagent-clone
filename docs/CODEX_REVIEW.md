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
