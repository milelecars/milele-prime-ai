# milele-prime-ai

Telegram bot backend for **Milele Prime AI** — a TypeScript / Node 22 service
that links brokerage clients to a Telegram assistant, computes trading metrics,
and delivers AI-generated reports.

> **Status: Phase 1 — skeleton only.** Config, schema, logging, typed connector
> interfaces, and a bot that boots and answers `/start` with a placeholder. No
> business logic yet.

## Requirements

- **Node.js 22+** (see `.nvmrc`)
- **Redis** (for BullMQ) — local or hosted
- **Supabase** project (Postgres + service-role key)
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather)

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#    …then fill in every value (see "Environment variables" below)

# 3. Apply the database migration (see "Database" below)

# 4. Run in development (long-polling, hot reload)
npm run dev
```

On boot the service:

1. Validates all environment variables — **fails fast** if any are missing/invalid.
2. Starts the HTTP server (health check at `/health`).
3. Starts the bot in **long-polling** mode (dev) or **webhook** mode (prod).

Send `/start` to your bot — it replies with the Phase-1 placeholder message.

## Scripts

| Script              | Description                                      |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Run with hot reload via `tsx watch`              |
| `npm run build`     | Compile TypeScript to `dist/`                    |
| `npm run start`     | Run the compiled build (production)              |
| `npm run typecheck` | Type-check without emitting                      |

## Environment variables

All variables are validated by `zod` at startup (`src/config/env.ts`). The
process exits with a descriptive error if any **required** variable is missing
or invalid.

### Required

| Variable                  | Description                                                        |
| ------------------------- | ----------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`      | Bot token from @BotFather.                                         |
| `SUPABASE_URL`            | Supabase project URL (`https://xxxx.supabase.co`).                 |
| `SUPABASE_SERVICE_KEY`    | Supabase **service-role** key. Server-side only — bypasses RLS.    |
| `LLM_API_KEY`             | API key for the LLM provider (Claude / Anthropic).                |
| `ELEVENLABS_API_KEY`      | API key for ElevenLabs voice synthesis.                           |
| `REDIS_URL`               | Redis connection string for BullMQ (`redis://…`).                 |
| `IDENTITY_SIGNING_SECRET` | Secret for HMAC-signing identity connect tokens (≥ 32 chars advised). |
| `CRM_SHARED_SECRET`       | Shared secret the Brokeret CRM presents to mint connect links.    |

### Required only when `USE_MOCK_CONNECTORS=false`

These are **optional while running on mocks** (the default) and become required
when real connectors are selected:

| Variable           | Description                              |
| ------------------ | ---------------------------------------- |
| `MT5_API_URL`      | Base URL of the MT5 Manager API.         |
| `MT5_API_KEY`      | API key for the MT5 Manager API.         |
| `BROKERET_API_URL` | Base URL of the Brokeret CRM API.        |
| `BROKERET_API_KEY` | API key for the Brokeret CRM API.        |

### Optional

| Variable                 | Default         | Description                                            |
| ------------------------ | --------------- | ------------------------------------------------------ |
| `USE_MOCK_CONNECTORS`    | `true`          | Use deterministic mock connectors instead of real APIs. |
| `LLM_MENTOR_MODEL`       | `claude-opus-4-8` | Claude model for mentor completions.                 |
| `LLM_CLASSIFIER_MODEL`   | `claude-haiku-4-5` | Cheap Claude model for the guardrail backstop.       |
| `LLM_MENTOR_MAX_TOKENS`  | `1024`          | Max output tokens per mentor completion.               |
| `LLM_MENTOR_EFFORT`      | _(unset)_       | `low`\|`medium`\|`high`\|`xhigh`\|`max` thinking effort for the mentor. |
| `ELEVENLABS_VOICE_ID`    | _(unset)_       | "Milele mentor" voice id (required to send voice notes). |
| `ELEVENLABS_MODEL_ID`    | `eleven_multilingual_v2` | ElevenLabs TTS model.                          |
| `DAILY_VOICE_ENABLED`    | `true`          | Voice note on/off for the daily drop.                  |
| `DAILY_REPORT_HOUR`      | `7`             | Local hour (per-user timezone) to deliver the drop.    |
| `DAILY_REPORT_GRANULARITY` | `weekly`      | `daily`\|`weekly` metrics window for the drop.         |
| `MARKETING_HOUR_LOCAL`   | `10`            | Local hour (per-user tz) to deliver marketing.         |
| `MARKETING_WEEKLY_CAP`   | `3`             | Max marketing messages per user per week (all campaigns). |
| `STT_PROVIDER`           | `whisper`       | `whisper`\|`deepgram` speech-to-text for inbound voice. |
| `OPENAI_API_KEY`         | _(unset)_       | Required when `STT_PROVIDER=whisper`.                   |
| `DEEPGRAM_API_KEY`       | _(unset)_       | Required when `STT_PROVIDER=deepgram`.                  |
| `CHAT_VOICE_EVERY_N`     | `4`             | Voice an inbound-chat reply every Nth turn (`0` off; voice-in always voices). |
| `ESCALATION_CHAT_ID`     | _(unset)_       | Internal Telegram chat id for human-handoff + cost alerts. |
| `SYSTEM_HALT`            | `false`         | Kill switch — halts ALL outbound + AI replies (flippable at runtime). |
| `COST_GLOBAL_DAILY_USD`  | `100`           | Global daily spend alert threshold (USD).              |
| `COST_USER_DAILY_USD`    | `5`             | Per-user daily hard ceiling (bronze base; tier-scaled). |
| `INBOUND_RATE_MAX`       | `20`            | Max inbound messages per user per window.              |
| `INBOUND_RATE_WINDOW_MS` | `60000`         | Inbound rate-limit window (ms).                        |
| `CONNECTOR_CACHE_TTL_MS` | `15000`         | Short-TTL cache duration for connector reads (ms). `0` disables. |
| `CONNECTOR_MAX_RETRIES`  | `3`             | Max attempts for retry-with-backoff around connector calls. |
| `TELEGRAM_BOT_USERNAME`  | _(fetched)_     | Bot username (no `@`) for deep links; falls back to Telegram's value. |
| `CONNECT_LINK_TTL_MS`    | `900000`        | Connect-link lifetime in ms (15 min).                  |
| `NODE_ENV`               | `development`   | `development` \| `test` \| `production`.               |
| `LOG_LEVEL`              | `info`          | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`\|`silent`. |
| `PORT`                   | `3000`          | HTTP port for the health/webhook server.               |
| `TELEGRAM_WEBHOOK_URL`   | _(unset)_       | If set, the bot runs in **webhook** mode at this public base URL. When unset, it uses long polling. |

Never commit secrets. `.env` is git-ignored; `.env.example` documents the shape.

## Database

Migrations live in `src/db/migrations/` (`0001_init.sql`, `0002_outbound.sql`,
`0003_inbound_sessions.sql`). Apply them in order via either:

- **Supabase SQL editor** — paste and run each file, or
- **psql** — `psql "$SUPABASE_DB_URL" -f src/db/migrations/0001_init.sql` (then `0002`, `0003`)

Migrations are idempotent (safe to re-run). `0002` adds `report_date` +
`tts_char_count` to `outbound_log` and a unique index enforcing one daily report
per client+date; `0003` adds chat session-state columns to `conversations`.
Tables created by `0001`:

| Table           | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `users`         | CRM clients; Telegram binding + consent flags.                 |
| `daily_metrics` | Precomputed per-client daily metrics (JSONB).                  |
| `conversations` | Chat sessions with token accounting.                          |
| `messages`      | Individual inbound/outbound messages (text/voice).            |
| `outbound_log`  | Queued/sent/failed outbound jobs (daily reports, marketing).  |
| `audit_log`     | Append-only audit trail of notable events.                    |

## Connectors (MT5 + Brokeret)

We don't yet have the MT5 Manager API or Brokeret CRM API docs, so the system is
built against **mocks** and real clients are swapped in later **without touching
business logic**.

- **Interfaces** (`connectors/mt5/types.ts`, `connectors/brokeret/types.ts`) are
  the only thing business logic depends on.
- **Two implementations each**:
  - `MockMT5Connector` / `MockBrokeretConnector` — deterministic fixtures
    (`connectors/fixtures.ts`) covering a winning trader, a losing trader, a
    weekend-holder, a zero-trades client, and an only-open-positions client.
  - `RealMT5Connector` / `RealBrokeretConnector` — stubs that throw
    `NotImplementedError("… — awaiting API docs")`, with `TODO` markers where
    endpoints/auth go.
- **Factory** (`config/connectors.ts`) selects mock vs real via
  `USE_MOCK_CONNECTORS` (default `true`) and exports wired `mt5` / `brokeret`
  singletons.
- **Wrappers**: every active implementation is transparently wrapped with
  retry-with-backoff (`connectors/retry.ts`) and a short-TTL cache
  (`connectors/cache.ts`) via a generic proxy (`connectors/instrument.ts`).

```ts
import { mt5, brokeret } from './config/connectors.js';
const summary = await mt5.getAccountSummary(500001); // retried + cached
```

## Identity binding (CRM → Telegram)

Links a CRM client to a Telegram user via a signed deep link.

1. **Mint a link** — the Brokeret CRM's Connect button calls
   `POST /internal/connect-link` with header `x-crm-secret: <CRM_SHARED_SECRET>`
   and body `{ "crmClientId": "crm-1001" }`. This endpoint **is** the
   client↔server auth handshake: the CRM proves identity with the shared
   secret, and the server returns a short-lived (15 min) HMAC-signed deep link
   `https://t.me/<bot>?start=<token>`. The token is compact (≤ 64 chars,
   `[A-Za-z0-9_-]`) so it fits Telegram's `start` parameter.

   ```bash
   curl -X POST https://<app>/internal/connect-link \
     -H "x-crm-secret: $CRM_SHARED_SECRET" \
     -H "content-type: application/json" \
     -d '{"crmClientId":"crm-1001"}'
   # → { "token": "...", "link": "https://t.me/<bot>?start=...", "expiresAt": "..." }
   ```

2. **Bind** — the bot's `/start` handler reads the token, verifies signature +
   expiry, captures the Telegram user ID, and persists the association in
   `users` (`telegram_user_id`, `bound_at`, `consent_ai_messaging=true`). The
   event is written to `audit_log`.

3. **Conflicts & idempotency** —
   - re-binding the *same* Telegram↔CRM pair is idempotent;
   - a Telegram ID already bound to a *different* client is rejected + logged;
   - a CRM client already bound to a *different* Telegram ID is rejected + logged;
   - expired/tampered tokens are rejected + logged.

4. **Guard** — `requireBoundUser` middleware gates every data-touching handler.
   Unbound users get _“Tap the Connect button in your Milele dashboard to link
   your account.”_ and are never served account data.

Persistence is behind a `UserRepository` interface: `SupabaseUserRepository`
(production) and `InMemoryUserRepository` (tests / local without a DB).

## Metrics (deterministic computation layer)

`src/metrics/` turns raw connector data into a typed `ClientMetrics` object
with **pure functions — no LLM, no API calls, no I/O in the math**. This is the
only place financial arithmetic happens: the AI later *narrates* these numbers
but never computes them.

- `compute.ts` — `computeClientMetrics(input)` (pure): win rate, P&L, best/worst
  trade, hold times, most-traded symbols, exposure concentration (HHI),
  drawdown, current open risk, week-over-week deltas, and behavioral flags
  (weekend holding, overleveraging, revenge-trading, clustering).
- `observations.ts` — `behavioralObservations`: plain-language **factual**
  statements about the user's *own* history (e.g. _“80% of your losses came
  from positions held over the weekend”_, _“your average hold time on winners
  is 3.0x your losers”_). Never market predictions, never forward-looking.
- `constants.ts` — named, auditable detection thresholds.
- `format.ts` — deterministic display formatting (rounded, with units).
- `gather.ts` — the **only** I/O: fetches from the connectors and assembles the
  pure `MetricsInput` (current + optional prior window).

```ts
import { gatherMetricsInput, computeClientMetrics } from './metrics/index.js';
import { mt5, brokeret } from './config/connectors.js';

const input = await gatherMetricsInput({ mt5, brokeret }, {
  crmClientId: 'crm-1001', granularity: 'weekly', referenceDate: '2025-06-22', includePrior: true,
});
const metrics = computeClientMetrics(input); // pure, deterministic
```

> Field naming note: the metrics object exposes `behavioralObservations`
> (camelCase, matching the rest of the codebase) for the array the spec calls
> `behavioral_observations`.

## LLM module (shared by daily report + chat)

`src/llm/` is the shared layer both Phase 4 (daily report) and Phase 5 (chat)
depend on. Built against **Claude** via the official `@anthropic-ai/sdk`.

- **Mentor system prompt** (`prompts.ts`) — a warm, sharp trading mentor that
  narrates a `ClientMetrics` object and **only** those numbers (never invents or
  recomputes). It states the one hard rule explicitly: no forward-looking market
  calls, signals, price predictions, or buy/sell/hold instructions — when asked,
  it deflects to education about the client's own exposure.
- **Guardrail** (`guardrail.ts`, `rules.ts`) — `checkOutbound(text)` scans model
  output before it's sent, in two layers: a free deterministic rules layer
  (keyword/pattern matching) and a cheap classifier LLM backstop
  (`claude-haiku-4-5`) for subtler phrasing. It is tuned **not** to false-positive
  on the user's own factual stats. On a trip it returns a flag + reason + a
  data-specific **deflection**; the caller decides whether to substitute (the
  daily report falls back to `buildDeterministicReport`, the chat substitutes the
  deflection). `guardrailAuditEvent` builds the `audit_log` entry for each trip.
- **Client** (`client.ts`) — `mentorCompletion`, `classifyOutbound`, and
  centralized token counting. **All user text is untrusted**: it travels only as
  `user` turns and is never merged into the system prompt or guardrail.
- **Transport** (`anthropic-transport.ts`) — the only network boundary, behind an
  `LLMTransport` interface so the whole module (and its tests) run offline.

```ts
import { createLLMClient, checkOutbound, buildDeterministicReport } from './llm/index.js';

const llm = createLLMClient();
const { text } = await llm.mentorCompletion({ metrics, conversation });
const guard = await checkOutbound(text, { metrics, classifier: (t) => llm.classifyOutbound(t) });
const toSend = guard.tripped ? buildDeterministicReport(metrics) : text; // report fallback
```

## Outbound — the daily drop

`src/outbound/` delivers a scheduled daily report as **three sibling outputs**
built from the same daily `ClientMetrics` (not a pipeline):

| Output | Source | Notes |
|---|---|---|
| **Text** | mentor narrative (Phase 4/5 LLM) | One mentor completion per client. On a guardrail trip, falls back to a deterministic template (no LLM). |
| **PDF** | the `ClientMetrics` object (`pdf.ts`, pdfmake) | Milele samurai aesthetic — obsidian black, electric-lime `#AEFE02`, royal-violet `#8538E1`; win/loss + per-symbol P&L charts. Built from metrics, **never** the text. |
| **Voice** | the narrative **TEXT** (`tts.ts`, ElevenLabs → OGG/Opus) | Native Telegram voice note (correct codec). **Never** the PDF. Tunable via `DAILY_VOICE_ENABLED`. |

Flow (`dailyReport.ts` → `processDailyReport`):
1. **Scheduler** (`scheduler.ts`) pulls active, consented (`consent_ai_messaging=true`),
   bound clients from the Brokeret connector and enqueues one job per client at
   **~7am in their own timezone** (`local-time.ts`), fanned out via BullMQ with a
   deterministic `jobId` (`daily:<client>:<date>`) so re-runs never double-enqueue.
2. The worker computes today's metrics, stores them in `daily_metrics`, calls the
   mentor **once**, runs the output through the guardrail (template fallback on a
   trip), then sends text → PDF → voice and logs to `outbound_log` + `messages`.
3. **Idempotent**: a unique index on `(crm_client_id, job_type, report_date)`
   (migration 0002) plus a "mark sent right after the text" ordering guarantees a
   client+date is never double-sent, even on retry. `outbound_log` records
   `voiced` and `tts_char_count` for cost tracking.

The core is pure orchestration over injected deps (`runtime.ts` wires the real
Claude / Supabase / grammY / ElevenLabs / pdfmake bundle), so the whole flow is
tested offline against fakes.

### Marketing campaigns (`marketing.ts`)

Pre-authored by Zain (**no LLM** for the body), lightly personalized via
`{{first_name}}` / `{{tier}}` template substitution. Supports **text, image, and
voice** payloads, on the same BullMQ queue + per-user local-time scheduling.

- **Consent** — gated on `consent_marketing`, a flag **separate** from
  `consent_ai_messaging`: a user can keep the mentor while opting out of
  marketing (and vice-versa). Never sent to `consent_marketing = false`.
- **Frequency cap** — `MARKETING_WEEKLY_CAP` messages per user per week,
  enforced **across all campaigns** (counted from `outbound_log`).
- **Scheduling** — one job per user at `MARKETING_HOUR_LOCAL` in their timezone.
- **Segmentation + dry-run** — Zain queues a campaign to a segment (filter by
  `account_tier`, `country`, `timezone`, plus `consent_marketing`) via the
  authenticated endpoints below; the dry-run returns the exact reach count
  before sending.
- Every send is logged to `outbound_log` with `job_type = marketing`.

```bash
# Dry-run: how many users will this segment reach?
curl -X POST https://<app>/internal/marketing/dry-run \
  -H "x-crm-secret: $CRM_SHARED_SECRET" -H "content-type: application/json" \
  -d '{"segment":{"tiers":["gold","platinum"],"countries":["AE","SG"]}}'
# → { "count": 2 }

# Queue a campaign (text; image/voice payloads pass dataBase64)
curl -X POST https://<app>/internal/marketing/campaign \
  -H "x-crm-secret: $CRM_SHARED_SECRET" -H "content-type: application/json" \
  -d '{"campaign":{"id":"jul-promo","name":"July promo","segment":{"tiers":["gold"]},
       "payload":{"kind":"text","body":"Hi {{first_name}}, your {{tier}} perks are live!"}}}'
# → { "campaignId": "jul-promo", "reach": 1 }
```

## Inbound — the conversational mentor

`src/inbound/` is the two-way chat pipeline (`handleMessage.ts → handleInbound`).
Every inbound message runs ten steps, all orchestration over injected deps
(testable offline):

1. **Identity** — unbound Telegram ID is refused with the connect message; no data served.
2. **Voice-in** — voice notes are downloaded and transcribed (`stt.ts`, Whisper or Deepgram, `STT_PROVIDER`-configurable), then handled as text.
3. **Session + budget** — load/open a `conversations` row (15-min idle reset). A per-session budget (tier-scaled exchanges OR tokens) drives three bands: **<70%** normal, **70–100%** inject a tighten/steer-to-close directive, **at cap** send a rotating graceful exit + recap, close the session, and start a cooldown after which the budget resets fresh.
4. **Routing** — simple metric lookups (drawdown, win rate, trade count, …) are answered **deterministically from the metrics engine with NO LLM call**. Coaching-phrased questions go to the model.
5. **Context assembly** — never full history: the client's `ClientMetrics`, a rolling summary (older turns summarized-and-dropped), and the last ~4 exchanges.
6. **Model call** — the Phase 3 mentor system prompt (own positions/behavior; never market calls).
7. **Guardrail** — every reply runs through `checkOutbound`; on a trip it's replaced with the educational deflection and logged to `audit_log`.
8. **Voice-out** — always when the user sent voice; otherwise occasionally (`CHAT_VOICE_EVERY_N`), via ElevenLabs → OGG/Opus native voice note.
9. **Escalation** — complaint / funds-problem / advice-demand language, or repeated guardrail trips, route to a human handoff (internal channel + audit) instead of an AI reply.
10. **Logging** — every inbound and outbound is written to `messages` with `token_count`; the session's running token total is updated.

Migration `0003` adds the session-state columns to `conversations`
(`exchange_count`, `rolling_summary`, `guardrail_trips`, `escalated`,
`cooldown_until`, …). Production wiring + the grammY text/voice handlers live in
`inbound/runtime.ts`.

## Production hardening (`src/ops/`)

Cross-cutting safeguards, wired into every pipeline as optional injected deps
(so they're fully testable offline) and Redis-backed in production
(`ops/wiring.ts`) so the kill switch and cost counters are shared across the web
and worker processes.

- **Kill switch** (`halt.ts`) — a single flag (`SYSTEM_HALT`) that instantly
  stops ALL outbound (daily reports, marketing) and AI replies, flippable at
  runtime **without a redeploy** via `POST /internal/halt {"halted":true}`
  (authenticated). While halted, inbound gets a brief "back shortly" ack.
- **Cost monitoring** (`cost.ts`) — tracks per-user and global daily spend
  across LLM tokens, TTS characters, and STT minutes (normalized to USD).
  Alerts (log + internal channel) once when the global daily threshold is
  crossed; enforces a tier-scaled per-user daily ceiling that triggers the
  Phase 5 graceful exit early for that user for the rest of the day.
- **Rate limiting** (`rateLimit.ts`) — per-user inbound sliding-window limit;
  excess messages get a soft "give me a sec" throttle, never a crash.
- **Prompt-injection defense** — all inbound text (typed and transcribed) is
  untrusted: it travels only as `user` turns and never enters the system prompt
  or guardrail. Forbidden replies are caught by `checkOutbound`.
- **Graceful degradation** — TTS down → text-only; LLM down → deterministic
  template; STT down → "please type"; connector down → "try again shortly" (and
  per-user queue jobs retry); the daily job is fanned out per user so one
  failure never sinks the batch.
- **Audit review** (`auditReview.ts` + `npm run audit:review`) — read guardrail
  trips, escalations, binding events, and conflicts from `audit_log`, filterable
  by date, client, and category.

> **Data isolation** is proven by `tests/data-isolation.test.ts` — an
> adversarial test showing user A can never reach user B's data via a direct
> message, a crafted query naming B, a forged Telegram ID, an injection attempt,
> or a forged/malformed deep link. The invariant: every data path derives the
> CRM id from the authenticated binding, never from message content.

## Testing

```bash
npm test   # node:test runner via tsx, env from tests/test.env
```

Covers: mock connector shapes for every fixture, `USE_MOCK_CONNECTORS`
selection, retry + cache behaviour, the full identity flow (valid/expired/
tampered tokens, idempotent + conflicting binds, unbound-user refusal), the
link-minting endpoint's shared-secret auth, and the metrics layer (zero trades,
all wins, all losses, single trade, open-only, weekend-holder, revenge,
clustering, and week-over-week deltas with/without a prior window), and the LLM
module (mentor narration with no invented numbers, guardrail catching every
forbidden category while leaving the user's own stats and educational content
untouched, prompt-injection neutralized, classifier backstop, and token
counting), and the outbound daily drop (scheduling at each client's local 7am,
per-client text report, idempotent double-send prevention, guardrail→template
fallback, branded PDF from metrics, and native voice note from the text). The
SQL migrations are validated separately against a real Postgres engine.

## Project structure

```
src/
  config/       Env loading + zod validation; connector factory (mock vs real)
  connectors/   MT5 + Brokeret interfaces, mock + real impls, retry/cache wrappers
  db/           Supabase client + SQL migrations
  metrics/      Pure metrics computation: compute, observations, format, gather
  identity/     Telegram↔CRM identity binding: tokens, links, repo, guard
  outbound/     Daily drop + marketing campaigns: scheduler, worker, store
  inbound/      Conversational mentor: pipeline, sessions, routing, STT, escalation
  llm/          Mentor prompt + guardrail (rules + classifier) + Claude client
  queue/        BullMQ queues + Redis connection
  bot/          grammY bot instance + typed context + webhook entrypoint
  ops/          Hardening: kill switch, cost, rate limit, audit review
  lib/          Logger, typed errors, utilities
  server.ts     HTTP server (health check + connect-link + webhook)
  index.ts      Application entrypoint
tests/          node:test suites (connectors, identity)
```

## Deployment (Railway)

`railway.json` and `Procfile` are included.

1. Create a Railway project and link this repo.
2. Add all required environment variables in the Railway dashboard.
3. Set `NODE_ENV=production` and `TELEGRAM_WEBHOOK_URL` to your public URL
   (e.g. `https://<app>.up.railway.app`) to run in webhook mode.
4. Railway runs `npm ci && npm run build`, then `npm run start`, and probes
   `/health`.

Connector methods currently throw `NotImplementedError` by design; real
integrations land in later phases.
