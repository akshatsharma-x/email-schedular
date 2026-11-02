# Outbox — Email Job Scheduler

A production-shaped email scheduling service: an Express/TypeScript API, a BullMQ
worker, Postgres as the durable ledger, Redis for scheduling and rate limiting,
Elasticsearch for search, and a Next.js **mail client** front end (sidebar +
list + reading pane + composer) with light and dark themes.

Built for the ReachInbox full-stack assignment. No cron anywhere.

```
outbox/
├── backend/      Express API + BullMQ worker (TypeScript)
├── frontend/     Next.js 16 mail client (TypeScript + Tailwind v4)
└── docker-compose.yml   Postgres, Redis, Elasticsearch
```

---

## Table of contents

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Setting up Ethereal, Google and Slack](#setting-up-ethereal-google-and-slack)
- [Architecture](#architecture)
  - [How scheduling works](#how-scheduling-works)
  - [How persistence across restarts works](#how-persistence-across-restarts-works)
  - [How idempotency works](#how-idempotency-works)
  - [How rate limiting and concurrency work](#how-rate-limiting-and-concurrency-work)
  - [Behaviour under load](#behaviour-under-load)
- [Feature checklist](#feature-checklist)
- [API reference](#api-reference)
- [Verifying it works](#verifying-it-works)
- [Tests](#tests)
- [Assumptions, trade-offs and known limits](#assumptions-trade-offs-and-known-limits)

---

## Quick start

**Prerequisites:** Node 20+, and either Docker or local Postgres 14+/Redis 6+.

### 1. Start the infrastructure

```bash
cd outbox
docker compose up -d          # Postgres :5432, Redis :6379, Elasticsearch :9200
```

<details>
<summary>Without Docker (Homebrew)</summary>

```bash
brew install redis postgresql@16
brew services start redis
brew services start postgresql@16
createdb outbox
```

Elasticsearch is optional — see [search](#search-elasticsearch-with-a-postgres-fallback).
Set `ELASTICSEARCH_ENABLED=false` to skip it.

</details>

### 2. Backend

```bash
cd backend
cp .env.example .env
#  -> set DATABASE_URL and JWT_SECRET (openssl rand -hex 32)
npm install
npm run migrate                        # applies backend/src/db/migrations/*.sql
npm run senders:create -- --count 2    # provisions real Ethereal SMTP mailboxes
npm run dev:all                        # API on :4000 + worker, together
```

Or run the two processes separately, which is how they are meant to be deployed:

```bash
npm run dev          # API  :4000
npm run dev:worker   # BullMQ worker
```

### 3. Frontend

```bash
cd frontend
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install
npm run dev                  # http://localhost:3000
```

### 4. Open it

| What | Where |
|---|---|
| Dashboard | <http://localhost:3000> |
| Live BullMQ board | <http://localhost:4000/admin/queues> |
| Health / readiness | <http://localhost:4000/health> · <http://localhost:4000/ready> |
| Prometheus metrics | <http://localhost:4000/metrics> |

Without Google credentials, set `DEV_AUTH_BYPASS=true` in `backend/.env` and use
**Continue as demo user** to exercise the whole dashboard. That endpoint refuses
to run when `NODE_ENV=production` — config validation rejects the combination at
boot, so it cannot become an auth bypass by accident.

---

## Configuration

Every throughput knob is read from the environment at boot. Nothing is hardcoded
in the source, and the process **refuses to start** on an invalid config rather
than silently defaulting (see [`config/env.ts`](backend/src/config/env.ts)).

| Variable | Default | What it does |
|---|---|---|
| `WORKER_CONCURRENCY` | `5` | Email jobs one worker sends in parallel |
| `MIN_DELAY_BETWEEN_EMAILS_MS` | `2000` | **Minimum gap between sends from the same sender** |
| `SEND_HOLD_MS` | `35000` | How long a sender's slot stays reserved while a send is in flight |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `200` | Per-sender hourly ceiling |
| `MAX_EMAILS_PER_HOUR` | `1000` | Tenant-wide hourly ceiling (`0` disables) |
| `QUEUE_LIMITER_MAX` / `_DURATION_MS` | `50` / `1000` | Coarse BullMQ-level valve |
| `SEND_MAX_ATTEMPTS` / `SEND_BACKOFF_MS` | `3` / `5000` | Retry policy for transient SMTP errors |
| `JOB_LEASE_MS` | `120000` | How long a worker may hold a claimed job before it is reclaimed |
| `RECONCILE_INTERVAL_MS` | `60000` | Postgres↔Redis divergence sweep |
| `ELASTICSEARCH_ENABLED` | `true` | `false` makes search use Postgres only |

**The delay we chose: a minimum of 2 seconds between sends from the same sender.**
Per-sender rather than global, because real providers throttle per account — two
senders can each send at t=0 without either violating its own limit.

---

## Setting up Ethereal, Google and Slack

### Ethereal (fake SMTP)

`npm run senders:create -- --count 2` calls `nodemailer.createTestAccount()`,
provisions throwaway mailboxes, and stores them as senders. It prints the
credentials — sign in at <https://ethereal.email/login> to read the mail that was
actually delivered. Every sent email also gets a direct preview link, surfaced as
**View** in the Sent table.

You can also add senders from the dashboard (**Add sender**), so a reviewer never
needs a terminal.

> Ethereal returns the *same* mailbox for rapid back-to-back calls; the script
> detects that and retries, so `--count N` reliably yields N distinct senders.

### Google OAuth

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials** →
   **OAuth client ID** → *Web application*
2. Authorised redirect URI: `http://localhost:4000/api/auth/google/callback`
3. Put the client ID and secret in `backend/.env`, restart the API.

The code exchange happens server-side, so the client secret never reaches the
browser, and the session is issued as an **httpOnly** cookie — an XSS bug cannot
exfiltrate it. Scopes requested: `openid email profile`, the minimum needed for
the name/email/avatar in the header.

### Slack OAuth (rate-limit alerts)

1. <https://api.slack.com/apps> → **Create New App** → *From scratch*
2. **OAuth & Permissions** → Redirect URLs: `http://localhost:4000/api/slack/callback`
3. Bot token scopes: `incoming-webhook`, `chat:write`
4. Put the client ID and secret in `backend/.env`, restart the API
5. In the dashboard, click **Connect Slack**, pick a channel, done.

Use **Send test message** to prove the wiring without waiting for a real limit
hit.

---

## Architecture

```
                    ┌──────────────────────┐
  Browser ─────────▶│  Next.js dashboard   │
      ▲             └──────────┬───────────┘
      │  SSE                   │ REST (cookie auth)
      │             ┌──────────▼───────────┐        ┌──────────────┐
      └─────────────│   Express API :4000  │───────▶│ Elasticsearch│
                    │  bull-board /admin   │        └──────────────┘
                    └───┬──────────────┬───┘               ▲
             (1) commit │              │ (2) enqueue       │ index
                    ┌───▼────────┐  ┌──▼──────────┐        │
                    │  Postgres  │  │    Redis    │        │
                    │  (ledger)  │  │  BullMQ +   │        │
                    │            │  │  limiters   │        │
                    └───┬────────┘  └──┬──────────┘        │
                        │              │ delayed jobs      │
                        │          ┌───▼──────────┐        │
                        └─────────▶│ BullMQ worker│────────┘
                       reconcile   │  + limiter   │──▶ Ethereal SMTP
                                   └──────┬───────┘
                                          └──▶ Slack webhook
```

**The central design decision: Postgres is the system of record; Redis is a
rebuildable index of *when to wake up*.** Everything below follows from that.

### How scheduling works

1. `POST /api/campaigns` validates the payload with Zod and parses the lead file
   **server-side** (the same parser that produced the UI's "N addresses detected"
   preview, so the count you approve is the count that gets scheduled).
2. The **planner** ([`queue/planner.ts`](backend/src/queue/planner.ts)) computes a
   feasible send plan up front: it round-robins recipients across the tenant's
   active senders and spaces each sender's sends to respect both the minimum gap
   and that sender's hourly ceiling, rolling overflow into later hour windows.
3. One transaction writes the campaign and one `email_jobs` row per recipient,
   each with its own `scheduled_at` and assigned sender.
4. **After the commit**, one `addBulk` creates a BullMQ **delayed job** per row,
   with `delay = scheduled_at - now` and `jobId = email_jobs.id`.

Scheduling is expressed purely as BullMQ delayed jobs — Redis's sorted set of
delayed jobs is what wakes them. **No cron, no `node-cron`, no polling loop over
the database.** The only `setInterval` in the codebase is the reconciler, which
never decides *when* an email sends; it only repairs divergence between Postgres
and Redis.

Why plan at schedule time instead of letting the limiter sort it out? If all 1000
recipients get the same `start_at`, 1000 jobs become runnable simultaneously, the
workers pull them, the limiter denies all but a handful, and 990 jobs get
re-delayed and thrash. It converges, but it burns Redis round-trips, loses
ordering, and the dashboard cannot tell the user when anything will actually be
sent. Planning first means **every recipient has a real predicted send time
immediately**, and the runtime limiter becomes a safety net rather than the
primary pacing mechanism.

### How persistence across restarts works

Three independent layers, because they cover different failures:

**1. Redis durability.** `docker-compose.yml` runs Redis with `appendonly yes`.
The delayed-job set survives an ordinary restart on its own, so the baseline
requirement — stop the server, start it again, future emails still fire at the
right time — is met by the delayed-job design alone.

**2. The reconciler** ([`queue/reconciler.ts`](backend/src/queue/reconciler.ts))
covers what Redis durability does not:

| Failure | What the reconciler does |
|---|---|
| Redis lost data (flushed, no AOF, failover to an empty replica) | Re-enqueues every `SCHEDULED` row from Postgres. Without this those emails would never send and nothing would report an error. |
| Worker died mid-send | The row is stuck in `SENDING` with a lease nobody owns. Lease expiry distinguishes "in flight" from "abandoned", so the job becomes eligible again instead of being stranded. |
| Service was down *across* a send time | Those rows are already due, are re-enqueued with zero delay, and go out immediately — rate-limited on the way out, so a long outage does not become a burst that trips the provider. |

It runs at boot and every `RECONCILE_INTERVAL_MS`, guarded by a Redis lock so
concurrent workers do not duplicate the sweep. Re-enqueueing is safe to run as
often as you like because `jobId` is the row id, so adding an existing job is a
no-op.

**3. Write ordering.** Postgres commits *before* Redis is touched. If the process
dies between the two, the database holds `SCHEDULED` rows with no Redis
counterpart and the reconciler picks them up. The reverse order would be
unrecoverable: a job in Redis with no durable row cannot be reconstructed. This is
the transactional outbox pattern — hence the project name.

### How idempotency works

Four layers, so that no single failure can double-send:

| Layer | Mechanism |
|---|---|
| **API** | `idempotencyKey` on `POST /api/campaigns` is a partial unique index. A retried or double-clicked request returns the *original* campaign with `deduplicated: true` and enqueues nothing. |
| **Row** | `email_jobs.dedupe_key` is `UNIQUE (campaign_id, recipient_email)` — a campaign physically cannot contain the same recipient twice. |
| **Queue** | `jobId = email_jobs.id`, so BullMQ silently ignores a duplicate `add`. Replays and reconciler sweeps cannot create a second job. |
| **Send** | A single conditional `UPDATE … WHERE id = $1 AND status = 'SCHEDULED'` claims the row. Evaluated under Postgres' row lock, so of N workers racing the same job, **exactly one** gets a row back and the rest no-op. This is what holds when BullMQ delivers a job twice after a crash, a stalled-job recovery, or a manual retry from the board. |

The `dedupe_key` also travels as an `X-Outbox-Idempotency-Key` SMTP header, so a
duplicate is detectable downstream and not just in our own database.

### How rate limiting and concurrency work

**Worker concurrency** is `WORKER_CONCURRENCY` (default 5). The per-send
guarantees do not depend on it being 1 — ordering and pacing come from the
limiter and the atomic claim, not from serialising the worker. Multiple worker
*processes* cooperate without any coordination beyond Redis.

**Admission control is one atomic Lua script**
([`ratelimit/scripts.ts`](backend/src/ratelimit/scripts.ts)). Deciding whether a
send may proceed reads three keys and conditionally writes three. Doing that with
separate round-trips lets two workers interleave between the check and the write
and both send — blowing the hourly cap. A Lua script runs atomically inside
Redis, so check-then-reserve is indivisible across any number of workers or
machines. The script checks **every** limit before reserving **any**, so a denial
mutates nothing and there is never a half-applied reservation to roll back.

```
ADMIT(sender, tenant, gap) ->
  1. per-sender hourly counter    full?  -> deny, retry at next window
  2. per-tenant hourly counter    full?  -> deny, retry at next window
  3. per-sender send gate       engaged? -> deny, retry at gap cadence
  4. all clear -> INCR both counters, reserve the gate, return a fencing token
```

- **Hourly limits** are fixed windows keyed `rl:sender:<id>:<YYYY-MM-DDTHH>`,
  with `INCR` + `EXPIRE`. Redis-backed, never in-memory, so they hold across
  instances.
- **The minimum delay** is a per-sender gate holding a "next allowed" timestamp.
  `admit` reserves it for `gap + SEND_HOLD_MS` and the worker *releases* it to
  `completedAt + gap` when the send finishes.

  That hold is the subtle part, and it is worth stating why it exists. Admission
  happens before the SMTP dialogue. If a send takes longer than the gap, the next
  job clears the gate and starts **while the first is still in flight** — one
  sender then holds several concurrent SMTP conversations, which is exactly what
  provider throttling exists to prevent, and observed `sent_at` deltas come out
  *smaller* than the configured minimum. Re-arming after the fact cannot fix it:
  by then the next send is already admitted. Holding the slot gives the crisp,
  observable guarantee: **for one sender, at most one send is in flight, and the
  next starts no sooner than the gap after the previous one finished.** A fencing
  token makes releasing safe — a send that overran its hold cannot clear a newer
  send's reservation.

**When a limit is hit, nothing is dropped or failed.** The row returns to
`SCHEDULED` with a new `scheduled_at`, `defer_count` is incremented, and the
*same* BullMQ job is re-delayed via `moveToDelayed` (preserving the job id, and
therefore the dedupe guarantee). A deferral does not consume a retry attempt.

**Order is preserved on deferral.** A naive implementation re-delays every
blocked job to the same instant, so hundreds wake simultaneously at the top of
the hour and get re-deferred in random order. Instead each job is placed at
`windowStart + sequence * gap`, reconstructing campaign order inside the new
window and spreading the wake-ups.

**Slack alerts are collapsed.** Hitting an hourly cap denies every remaining job,
so the raw event fires hundreds of times. A Redis `SET NX` claim reduces that to
**one message per sender per hour window**. If the user has not connected Slack
it is a silent no-op, never an exception. If Slack answers 403/404/410 the
webhook is marked revoked so we stop hammering a dead URL — and reconnecting
clears the flag at runtime, with no redeploy.

### Behaviour under load

**1000 emails all scheduled for the same instant**, 2 senders at 200/hour each:

```
$ npm run loadtest -- --count 1000 --dry-run

  recipients:        1000
  senders:           2
  per-sender/hour:   200
  min delay:         2000 ms
  first send:        2026-11-02T08:19:16Z
  last send:         2026-11-02T10:03:18Z
  span:              104 min
  hour windows used: 3
  aggregate rate:    400 emails/hour
```

Measured on the real write path (`npm run loadtest -- --count 1000`): 1000 rows
inserted and enqueued in **159 ms**, distributed exactly to the cap —

| hour window | Ethereal 1 | Ethereal 2 |
|---|---|---|
| window 1 | 200 | 200 |
| window 2 | 200 | 200 |
| window 3 | 100 | 100 |

- Inserts and `addBulk` are chunked (500 / 1000), so a 100k-recipient campaign
  does not exceed Postgres' parameter limit or build one enormous Redis command.
- If the limit would be exceeded anyway — competing campaigns, a restart, a
  tightened cap — the limiter defers into the next window rather than dropping.
- `QUEUE_LIMITER_MAX` is a coarse valve in front of the precise limiter, so a
  large backlog cannot slam SMTP in the instant a window opens.

### Search: Elasticsearch with a Postgres fallback

Scheduled and sent emails are indexed into Elasticsearch
([`search/`](backend/src/search)) with an email-aware analyser, so searching
`zomato` finds `lead@zomato.in` — the standard analyser keeps a whole address as one
token and partial search silently fails.

ES is treated as a **disposable read optimisation**: nothing in the send path
blocks on it, indexing failures are non-fatal, and `npm run search:reindex`
rebuilds the index from Postgres. If ES is unreachable, the same query is served
from Postgres and the response says which engine answered — the dashboard shows
`via elasticsearch` or `via postgres`. An ES outage degrades relevance; it does
not break the page, and `/ready` does not fail on it.

---

## Feature checklist

### Backend

| Requirement | Status | Where |
|---|---|---|
| TypeScript + Express | ✅ | [`app.ts`](backend/src/app.ts), [`server.ts`](backend/src/server.ts) |
| BullMQ + Redis, delayed jobs | ✅ | [`queue/queues.ts`](backend/src/queue/queues.ts), [`scheduler.ts`](backend/src/queue/scheduler.ts) |
| Postgres via Drizzle + SQL migrations | ✅ | [`db/`](backend/src/db) |
| Ethereal SMTP, multiple senders | ✅ | [`mailer/`](backend/src/mailer) |
| Elasticsearch indexing + search | ✅ ¹ | [`search/`](backend/src/search) |
| Live BullMQ dashboard | ✅ | `/admin/queues` — [`admin/bullboard.ts`](backend/src/admin/bullboard.ts) |
| Survives restart, no duplicates | ✅ | [`reconciler.ts`](backend/src/queue/reconciler.ts), [`repository.ts`](backend/src/queue/repository.ts) |
| Configurable worker concurrency | ✅ | `WORKER_CONCURRENCY` |
| Minimum delay between sends | ✅ | 2s default, atomic per-sender gate |
| Emails/hour limit, per sender *and* per tenant | ✅ | [`ratelimit/`](backend/src/ratelimit) |
| Limits configurable via env, no hardcoding | ✅ | [`config/env.ts`](backend/src/config/env.ts) |
| Multi-worker-safe, Redis-backed counters | ✅ | atomic Lua, verified under 200-way contention |
| Limit hit → delay/reschedule, preserve order | ✅ | `moveToDelayed` + sequence-aware placement |
| Slack OAuth + live alert on limit hit | ✅ | [`integrations/slack/`](backend/src/integrations/slack) |
| Slack disconnect / reconnect, no crash | ✅ | revocation detection, runtime reconnect |
| No cron anywhere | ✅ | delayed jobs only |
| Idempotency | ✅ | four layers, see above |

> ¹ **Verification note, stated plainly.** Everything else in this table was
> exercised against the running stack (see
> [Verifying it works](#verifying-it-works)). The Elasticsearch path was
> developed against the v8 client and its mapping/query DSL but the local runs
> used `ELASTICSEARCH_ENABLED=false`, so what was actually observed end-to-end is
> the **Postgres fallback** — search returning `via postgres`. To exercise the ES
> path: `docker compose up -d elasticsearch`, set `ELASTICSEARCH_ENABLED=true`,
> run `npm run search:reindex`, and the search response should report
> `via elasticsearch`.

### Frontend

Built to the provided Figma: a mail client, not a card dashboard — left rail with
the account chip and folders, a search row, list rows in the
`To: … | status | Subject - preview` format, a reading pane, and a full-page
composer. Light theme by default with a **dark/light toggle in the top bar**.

| Requirement | Status | Where |
|---|---|---|
| Real Google OAuth, redirect to dashboard | ✅ | [`login/page.tsx`](frontend/src/app/login/page.tsx) |
| Header with name, email, avatar, logout | ✅ | account chip in [`Sidebar.tsx`](frontend/src/components/mail/Sidebar.tsx) |
| Scheduled / Sent sections | ✅ | sidebar folders, [`dashboard/page.tsx`](frontend/src/app/dashboard/page.tsx) |
| "Compose New Email" button | ✅ | sidebar, matching the Figma's mint fill |
| Compose: subject, body | ✅ | [`Composer.tsx`](frontend/src/components/mail/Composer.tsx) |
| CSV/text upload + detected count | ✅ | "Upload List", server-parsed, with duplicate/invalid counts |
| Start time, delay, hourly limit inputs | ✅ | Send Later popover + the delay / hourly pair |
| Scheduled list: email, subject, time, status | ✅ | [`MailList.tsx`](frontend/src/components/mail/MailList.tsx) |
| Sent list: email, subject, sent time, status | ✅ | same component, folder-driven |
| Loading states | ✅ | row-shaped skeletons, inline progress on refetch |
| Empty states | ✅ | per folder, plus a distinct "no search results" |
| Error handling / toasts | ✅ | [`Toaster.tsx`](frontend/src/components/ui/Toaster.tsx) |
| Reusable components, DRY | ✅ | [`components/ui/`](frontend/src/components/ui) — one list serves all three folders |
| Typed API responses and props | ✅ | [`types/api.ts`](frontend/src/types/api.ts), [`lib/api.ts`](frontend/src/lib/api.ts) |

Also in the Figma and implemented: **From** sender picker, recipient **chips with
a `+N` overflow**, **rich-text toolbar** (bold/italic/underline, alignment,
lists, indent, link, clear), **attachments** with image thumbnails, the
**Send Later** popover with presets, **starring**, and the **reading pane** with
sender block and attachment cards.

### Beyond the brief

- **Light / dark theme** — one set of role tokens, applied before first paint by
  an inline script so a dark-mode user never sees a white flash. Follows the OS
  until the user picks a side explicitly.
- **Live updates over SSE** — worker → Redis pub/sub → per-tenant SSE stream, so
  the list updates as sends happen instead of polling. Events are tenant-scoped.
- **Send planner** — every recipient gets a predicted send time at schedule time.
- **Per-sender circuit breaker** — three consecutive failures park a sender for
  15 minutes; jobs are reassigned to a healthy one instead of failing.
- **Graceful search degradation** — Postgres fallback, with the engine named in
  the response.
- **Observability** — `/metrics` (deferrals by reason, SMTP latency, queue
  depth), `/health`, `/ready` with per-dependency status, structured logs with
  secret redaction.
- **Multi-tenancy** — every query is scoped by the authenticated user; Slack
  tokens and senders are per-tenant.
- **Accessibility** — status is never colour alone (dot + label everywhere); the
  palette was validated with a contrast/colour-blindness checker rather than
  eyeballed.

---

## API reference

All data routes require the session cookie and are scoped to the authenticated
user. Errors use one envelope: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/auth/config` | Which auth methods are available |
| `GET` | `/api/auth/google` | Start Google OAuth |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/auth/logout` | Clear the session |
| `POST` | `/api/auth/dev-login` | Dev-only login (`DEV_AUTH_BYPASS`) |
| `POST` | `/api/leads/parse` | Parse a lead file → detected / duplicate / invalid counts |
| `POST` | `/api/campaigns` | **Schedule a campaign** (accepts `idempotencyKey`) |
| `GET` | `/api/campaigns` | Campaigns with progress counters |
| `POST` | `/api/campaigns/:id/cancel` | Cancel everything not yet sent |
| `GET` | `/api/emails?status=…&q=…` | Scheduled / Sent tables (and search) |
| `GET` | `/api/emails/search?q=…` | Explicit Elasticsearch search |
| `GET` | `/api/emails/stats` | Folder counters |
| `GET` | `/api/emails/:id` | Full message for the reading pane |
| `PATCH` | `/api/emails/:id` | Star / unstar |
| `POST` | `/api/attachments` | Multipart upload (5 files, 10 MB each) |
| `GET` | `/api/attachments/:id` | Stream a file back (owner-scoped) |
| `DELETE` | `/api/attachments/:id` | Remove an unlinked upload |
| `GET` | `/api/senders` | Senders **with live hourly usage from Redis** |
| `POST` | `/api/senders/ethereal` | Provision a new Ethereal sender |
| `PATCH` | `/api/senders/:id` | Pause/resume, change the hourly cap |
| `GET` | `/api/slack/status` | Connection state |
| `GET` | `/api/slack/install` | Start Slack OAuth |
| `POST` | `/api/slack/test` | Send a test Slack message |
| `POST` | `/api/slack/disconnect` | Disconnect Slack |
| `GET` | `/api/system/queue` | Queue depth + effective config |
| `POST` | `/api/system/reconcile` | Run the recovery sweep on demand |
| `GET` | `/api/events` | SSE stream of live events |

<details>
<summary><code>POST /api/campaigns</code> example</summary>

```bash
curl -X POST http://localhost:4000/api/campaigns \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{
    "subject": "Quick question",
    "body": "Hi there,\n\nSaw your launch…",
    "recipients": [{ "email": "adyasha.singh@example.com", "name": "Adyasha Singh" }],
    "startAt": "2026-11-02T10:00:00.000Z",
    "minDelayMs": 2000,
    "maxPerHour": 200,
    "idempotencyKey": "campaign-2026-11-02-a"
  }'
```

```jsonc
{
  "campaign": { "id": "…", "status": "ACTIVE", "totalRecipients": 1 },
  "plan": {
    "totalEmails": 1, "senderCount": 2,
    "firstSendAt": "2026-11-02T10:00:00.000Z",
    "lastSendAt":  "2026-11-02T10:00:00.000Z",
    "spanMinutes": 0, "windowsUsed": 1,
    "effectiveMinDelayMs": 2000, "perSenderHourly": 200
  },
  "enqueued": 1,
  "deduplicated": false,
  "recipients": { "scheduled": 1, "invalid": 0, "duplicates": 0 }
}
```

</details>

---

## Verifying it works

### Restart persistence (the headline requirement)

```bash
# 1. schedule something in the future
curl -X POST http://localhost:4000/api/campaigns -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"subject":"Survives restart","body":"hi",
       "recipients":[{"email":"a@example.com"}],
       "startAt":"'"$(node -e 'console.log(new Date(Date.now()+75000).toISOString())')"'"}'

# 2. kill BOTH processes, and wipe Redis entirely for good measure
pkill -f worker.ts; pkill -f server.ts
redis-cli FLUSHALL          # simulate catastrophic queue loss

# 3. Postgres still holds the truth
psql -d outbox -c "select recipient_email, status from email_jobs where status='SCHEDULED'"

# 4. start again -- the reconciler rebuilds the queue from Postgres
npm run dev & npm run dev:worker
```

Observed output:

```
WARN: re-enqueued durable jobs that were missing from redis
    requeued: 3   overdue: 3
INFO: reconcile sweep complete
    checked: 3  requeued: 3  reclaimed: 0  tookMs: 20
```

…and all three sent **exactly once** — one attempt, one distinct provider
message id each — despite a total Redis wipe and being hours overdue.

### Rate limiting under contention

Two campaigns competing for one sender, `minDelayMs=2000`:

```
 recipient        defers  sent_at        gap_ms
 fm1@example.com       0  23:55:44.363        —
 fn1@example.com       4  23:55:49.338     4975
 fn2@example.com       6  23:55:53.434     4096
 fm2@example.com       8  23:55:57.122     3688
 fm3@example.com       9  23:56:00.565     3443
 fn3@example.com      11  23:56:04.274     3709
```

Every gap is above the 2000 ms minimum, nothing was dropped, and the deferral
counts show the limiter repeatedly rescheduling rather than failing.

### Hourly limit → Slack

Exceed a sender's hourly cap and the worker logs:

```
INFO: send deferred by limiter
    reason: "SENDER_HOURLY_LIMIT"
    runAt: "2026-11-02T09:00:00.000Z"     <- start of the next hour window
```

Jobs land at `09:00:00.000` and `09:00:00.500` — spaced by the sequence offset,
so campaign order survives the deferral. With Slack connected, exactly one
message is posted per sender per window. With Slack *not* connected, zero errors
— verified.

### Idempotency

```bash
# same request twice
$ curl -X POST … -d '{…,"idempotencyKey":"dup-key-12345678"}'
  attempt 1 -> campaign: adb679a8-… | deduplicated: false | enqueued: 1
  attempt 2 -> campaign: adb679a8-… | deduplicated: true  | enqueued: 0
rows created: 1    campaigns created: 1
```

---

## Tests

```bash
cd backend && npm test          # 53 tests
```

| Suite | Covers |
|---|---|
| `tests/limiter.test.ts` | Hourly caps, the min-delay gate, fencing-token release, recheck cadence — **against a real Redis**, because the property under test is atomicity under concurrency, which a mock cannot demonstrate. Includes a 200-way race asserting the counter matches admissions *exactly*. |
| `tests/planner.test.ts` | Spacing, round-robin, per-window caps, overflow into later windows, order preservation, the 1000-at-once case. |
| `tests/leads.test.ts` | CSV with/without headers, quoted fields, display-name form, BOM + CRLF, duplicates, invalid rows, mixed-format files. |

`npm run typecheck` is clean in both packages under `strict` +
`noUncheckedIndexedAccess`.

---

## Assumptions, trade-offs and known limits

**Assumptions**

1. **The Figma link itself returns 403 without an account**, so the UI was built
   from a screenshot of it. Layout, wordmark, folder rail, row format, composer
   fields and the Send Later popover follow the design; exact spacing and type
   scale are approximations, not pixel-matched. Brand colours were **sampled from
   the screenshot** and then adjusted where they failed contrast — the design's
   green (`#05a63f`) gives white button text only 3.21:1, so buttons use
   `#037d2e` (5.28:1), which reads as the same green. Status colours ship with an
   icon *and* a label because green/amber are indistinguishable under
   deuteranopia (ΔE 4.1) and a green-brand mail client needs both.
2. One Slack workspace per user, and senders belong to a user. "Tenant" and
   "user" are the same thing here.
3. Hourly limits use **fixed** windows aligned to the epoch hour.
4. Lead files are CSV or plain text. Excel/XLSX is not parsed.

**Trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Fixed hour windows, not sliding | One `INCR` per send; trivially correct under concurrency | A burst can straddle a boundary, allowing up to 2× the limit within some 60-minute span. A sliding window needs a sorted set per sender and far more memory. |
| Plan at schedule time *and* enforce at send time | The plan gives predicted times and avoids stampedes; the limiter stays correct when reality diverges | The same rule is expressed in two places; they are kept consistent by sharing `MIN_DELAY`/hourly inputs, and both are tested. |
| Hold the sender slot for `SEND_HOLD_MS` | The only way to guarantee one in-flight send per sender | If a worker dies mid-send, that sender pauses until the hold expires (35s default). Fail-closed was chosen over risking a double-send. |
| Deferred jobs re-poll at the gap cadence | A blocked job must not sleep out the pessimistic hold | Effective spacing overshoots the minimum by up to one gap (observed 3.4–5.0s for a 2s minimum). Never *under*, which is the direction that matters. |
| Quota consumed before the send | Fail-closed: a crash mid-send cannot over-send | A permanently-failing send still consumes quota, as it would with a real provider. |
| Stateless JWT sessions | No session store; works with any number of API replicas | Logout is client-side only. A revocation list is the next step for production. |
| Hand-written SQL migrations + Drizzle for queries | The schema stays readable and reviewable; no codegen step to trust | The Drizzle schema mirrors the SQL and could drift; `typecheck` plus the integration path catch it. |

**Known limits**

- `/admin/queues` is gated on the app session cookie. Anyone who can log in can
  retry or remove jobs; a separate credential would be the next step.
- SSE assumes one API process per client connection. Multiple replicas work (each
  subscribes to the same Redis channel), but a sticky-session-free load balancer
  will reconnect clients on deploy — `EventSource` retries automatically.
- Elasticsearch indexing is best-effort at write time. A row indexed while ES was
  down stays unindexed until `npm run search:reindex`; it remains fully visible in
  the tables, which read from Postgres.
- The list pages 60 rows at a time without infinite scroll; the Starred folder
  filters the fetched page client-side rather than querying the server.
- The rich-text editor uses `document.execCommand`, which is formally deprecated
  but remains the only cross-browser API for this. It covers inline marks,
  lists, alignment and links — not tables or images-in-body.
- Attachments are stored on local disk under `backend/uploads/`. Swapping in S3
  means changing `storage_path` and one route; nothing else sees a file path.
- `Cross-Origin-Resource-Policy` is relaxed to `cross-origin` so the frontend can
  embed attachment images from the API's origin. Reads are still gated by the
  session cookie and scoped to the owning user.
