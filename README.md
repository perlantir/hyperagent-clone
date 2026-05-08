# Hyperagent Clone

A from-scratch implementation of a Hyperagent.com-style agent platform. Built in
phases:

| Phase | Scope |
|------:|-------|
| 0 | Design prototype (separate `design.html` artifact) |
| 1 | Interactive single-HTML demo (separate `phase1.html` artifact) |
| 2 | Next.js + SQLite + Anthropic streaming chat with tool calling |
| 3 | Cookie-session auth, signup/login, user-scoped data |
| 4 | Connector marketplace (Slack, Gmail, Linear, Stripe, GitHub, Notion, Airtable, HubSpot, Drive, Postgres) — each exposes its API as tools an agent can call |
| 5 | In-process scheduler + automation templates (Live mode) |
| 6 | Memory store (global / agent-scoped / project-scoped) injected into system prompt |
| 7 | Projects (group threads, agents, and memories) |
| 8 | Multi-agent smart routing — meta-agent picks the best specialist |
| 9 | Credit system with transaction log + top-up packages |
| 10 | Skills library — installable system-prompt templates |

This repo is a single Next.js codebase. Everything from Phase 2 onward is
implemented and runnable.

## Stack

- **Framework**: Next.js 14 App Router + TypeScript
- **DB**: SQLite via `better-sqlite3` (file-based, zero setup)
- **LLM**: Anthropic Claude (Sonnet 4.5 default, configurable)
- **Streaming**: Server-Sent Events to the browser
- **Styling**: CSS variables (light + dark theme) + minimal Tailwind config
- **Scheduler**: in-process `setInterval` polling (fine for local dev; swap for BullMQ/Redis in prod)
- **Auth**: cookie session with scrypt-hashed passwords
- **Search tool**: DuckDuckGo HTML (no API key required)
- **Demo user**: `demo@hyperagent.local` / `demo` is seeded on first run

## Quick start

```bash
cp .env.example .env.local
# Edit .env.local and add your ANTHROPIC_API_KEY

npm install
npm run dev
```

Open <http://localhost:3000> and sign in with the demo account.

## Required env vars

- `ANTHROPIC_API_KEY` — get one at <https://console.anthropic.com>
- `ANTHROPIC_MODEL` — defaults to `claude-sonnet-4-5-20250929`
- `DB_PATH` — defaults to `./data/hyperagent.db`

## What's wired vs. stubbed

**Real**:
- Streaming chat with tool calling and a multi-step tool loop
- `web_search` (DuckDuckGo HTML scrape)
- `generate_artifact` (saves HTML artifact to DB, viewable at `/api/artifacts/:id?render=1`)
- Slack `slack_send_message` (real `chat.postMessage` API call once you paste a bot token)
- Linear `linear_search_issues` (real GraphQL query)
- Stripe `stripe_list_charges`, `stripe_get_customer` (real API)
- GitHub `github_search` (real API)
- Airtable `airtable_list_records`, `airtable_create_record` (real API)
- Multi-agent router (calls Claude with the candidate list, parses JSON)
- In-process scheduler running every 60s
- Credit accounting on every chat completion
- Memory injection into system prompt
- Skill templates installable per user

**Stubbed (returns text-only acknowledgement)**:
- `gmail_search`, `gmail_send` — would need full OAuth flow
- `notion_search`, `notion_append` — handler scaffolding only
- `drive_search`, `drive_read` — same
- `pg_query` — would need pg client wired up
- `slack_notify` — pure log stub for use without real Slack
- HubSpot writes
- Stripe top-up payment (currently credits the account immediately on POST — wire to Stripe Checkout in production)

## Project layout

```
src/
├── app/                  # Next.js App Router pages + api routes
│   ├── api/
│   │   ├── auth/         # login, signup, logout, me
│   │   ├── chat/         # streaming chat (the heart)
│   │   ├── threads/[id]/ # CRUD
│   │   ├── agents/[id]/  # CRUD
│   │   ├── memories/     # global memory store
│   │   ├── projects/     # project folders
│   │   ├── connectors/   # integration registry + credentials
│   │   ├── skills/       # template library + user skills
│   │   ├── automations/  # automation templates
│   │   ├── schedules/    # active automations
│   │   ├── runs/         # automation run history
│   │   ├── credits/      # balance + top-up
│   │   ├── library/      # all artifacts for current user
│   │   └── artifacts/[id]/ # render artifact HTML
│   ├── login/
│   ├── threads/[id]/
│   ├── agents/[id]/, agents/new/
│   ├── projects/, projects/[id]/
│   ├── library/, learning/, skills/, integrations/, live/, billing/
│   ├── layout.tsx, page.tsx, globals.css
├── components/
│   ├── AppShell.tsx, Sidebar.tsx, Topbar.tsx, ThemeToggle.tsx
│   ├── ChatView.tsx      # streaming chat with tool cards + artifacts
└── lib/
    ├── db.ts             # SQLite + all queries
    ├── auth.ts           # cookie sessions
    ├── llm.ts            # Anthropic client
    ├── tools.ts          # built-in + connector tools
    ├── connectors.ts     # static connector registry
    ├── automation-templates.ts # automation recipe library
    ├── memory.ts         # memory retrieval + system-prompt block
    ├── router.ts         # multi-agent smart routing
    ├── credits.ts        # token-cost accounting
    ├── scheduler.ts      # in-process schedule loop
    └── types.ts
```

## Demo flow

1. Log in as `demo@hyperagent.local` / `demo` — you start with 10,000 credits.
2. Open the seeded "EU AI Act briefing" thread (or any other) and chat — Claude
   streams the response with tool calls and artifacts.
3. Visit **Skills** → install "Board memo writer" → it shows up in **Learning**.
4. Visit **Integrations** → connect Slack with a bot token → Slack tool becomes
   available for any agent that includes `slack_send_message` in its tools.
5. Visit **Live mode** → pick the "Competitor pricing watch" template, point it
   at any agent, set 10-minute interval, activate. The scheduler will run it.
6. Visit **Billing** → buy a Pro pack — your balance jumps 25,000.
7. Start a thread without picking an agent → check "Smart route" in the composer
   → the router will pick the best specialist for your prompt.

## Production checklist (what's NOT done)

This is an MVP. To run for real users you'd want:

- [ ] Migrate from SQLite to Postgres (Prisma works)
- [ ] Real Stripe Checkout for top-ups
- [ ] OAuth flows for connectors instead of pasted tokens
- [ ] BullMQ/Redis for the scheduler so it survives restarts
- [ ] Vector embeddings for memory recall instead of "include all"
- [ ] Sandbox HTML artifact rendering (currently renders straight)
- [ ] CSP / rate limiting / abuse protection
- [ ] Email verification, password reset, MFA
- [ ] Observability (OpenTelemetry, Sentry)
- [ ] Multi-tenant orgs and team permissions
- [ ] The remaining ~95% of features that make the real product good

## License

MIT for the code. Use freely.
