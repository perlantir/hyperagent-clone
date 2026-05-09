# hyperagent-codex-relay

Long-lived relay/control-plane for Hyperagent's **Codex Companion** mode (P66c).

## Why this exists

Vercel Functions cannot host a long-lived bidirectional WebSocket. The companion needs an outbound, always-available endpoint to connect to. This relay is a small, stateless Node service that:

1. accepts the companion's outbound `wss://relay/companion` connection
2. forwards Vercel's `POST /dispatch` packets over the WS
3. forwards companion-emitted events back to Vercel's `POST /api/codex/relay/inbox`

The relay holds **no tokens** and stores **no events**. State (companion registry, dispatch queue, run events) lives in Vercel's Postgres. The relay is just a fast pipe with HMAC + JWT verification.

## Deploy on Fly.io (alpha)

```sh
cd packages/codex-relay
fly launch --copy-config --no-deploy --name hyperagent-codex-relay
fly secrets set \
  RELAY_SHARED_SECRET=<32+ char random> \
  CODEX_RUN_TICKET_KEY=<same value as Vercel> \
  VERCEL_INBOX_URL=https://app.example.com/api/codex/relay/inbox
fly deploy
```

A single `shared-cpu-1x@256MB` instance is enough for hundreds of concurrent companions; we'll re-evaluate at thousands.

## Deploy locally for development

```sh
RELAY_SHARED_SECRET=$(openssl rand -hex 32) \
CODEX_RUN_TICKET_KEY=$(openssl rand -hex 32) \
VERCEL_INBOX_URL=http://localhost:3000/api/codex/relay/inbox \
PORT=8400 \
node src/server.js
```

Use the same `CODEX_RUN_TICKET_KEY` value in your local Vercel `.env.local`.

## Endpoints

| Method+path | Auth | Purpose |
|-------------|------|---------|
| `WS    /companion`           | Companion JWT (first message) | long-lived companion → relay session |
| `POST  /dispatch`            | HMAC of body                  | Vercel asks relay to push a packet to a companion |
| `POST  /cancel`              | HMAC of body                  | Vercel asks relay to push cancel |
| `GET   /healthz`             | none                          | k8s/Fly probe |
| `GET   /connections/:cid`    | HMAC of `GET /connections/:cid` | Vercel asks "is this companion online?" |

## Logging

Structured JSON to stdout. Never includes payload bytes. Sample:

```json
{"ts":"2026-05-09T21:40:00Z","level":"info","msg":"companion_connected","companionId":"cmp_abc12345…"}
{"ts":"2026-05-09T21:40:05Z","level":"info","msg":"dispatch_forwarded","companionId":"cmp_abc12345…","runId":"run_de…","kind":"dispatch","bytes":312}
```

## Security model

- **No raw tokens.** Codex/ChatGPT tokens never leave the user's machine.
- **No payload persistence.** If the relay crashes mid-flight, the companion replays from `lastSeenAcknowledgedSeq` on reconnect.
- **HMAC + JWT, both required.** Vercel→relay is HMAC; companion→relay is JWT (issued by Vercel via `/api/codex/pair/heartbeat`).
- **In-memory connection map.** Last-writer-wins on conflict (re-pairs and restarts always claim cleanly).
- **No request body logging.** Only metadata (counts, sizes, latency).

## Limits

- One companion per `companionId` at a time. If the companion reconnects, the prior WS is closed with code 4000.
- 1 MB max body on `/dispatch` and `/cancel`.
- Relay has no rate limiter today; rely on Vercel-side per-user gating until traffic justifies adding one.

## Status

**Experimental alpha.** Production-ready for one user / a small org. For multi-region failover, multi-tenant fairness, and replay durability, see P66+ work.
