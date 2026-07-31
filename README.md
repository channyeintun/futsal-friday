# Futsal Friday

A small web app for a group of friends who play futsal every Friday at 19:30
(Asia/Ho_Chi_Minh). It replaces the two things the organizer currently does by
hand: posting the registration list in the group chat, and chasing everyone for
their share of the pitch fee.

Runs entirely on free tiers — Cloudflare Workers, D1, R2, Pages, and Upstash
Redis — and is structured so the frontend can be lifted into a Zalo Mini App
later without rewriting the UI.

---

## What it does

- **Weekly session auto-creation.** A cron job makes sure the upcoming Friday
  19:30 exists, inheriting the venue, fee and player cap from the last game.
- **Venues.** A short list of pitches with address, map link and price note.
- **Registration.** One button to join or drop out. Live list in registration
  order, an optional player cap, and a waitlist that promotes automatically
  when somebody withdraws. Closes at kickoff.
- **Payments.** The organizer enters the total charge; it splits equally among
  the players who actually played, with per-person overrides. Members mark
  themselves paid and can attach a transfer screenshot; the organizer confirms
  or rejects. `unpaid → pending → confirmed`.
- **Dashboards.** Who has paid, who hasn't, running totals per session, and
  outstanding balance per member across all sessions.
- **Copy summary.** One tap produces a plain-text snapshot of the registration
  list or the payment status, formatted for pasting into the group chat.
- **Realtime.** Registrations, withdrawals and payment updates appear on
  everyone's screen without a refresh, with automatic fallback to polling.

---

## Layout

```
futsal-friday/
├── shared/      types, zod schemas, and pure helpers used by both sides
│   ├── models.ts     domain models + request validation
│   ├── events.ts     the six realtime events, defined once
│   ├── time.ts       Asia/Ho_Chi_Minh arithmetic
│   ├── money.ts      integer-dong splitting
│   └── summary.ts    the chat-pasteable text
├── api/         Hono on Cloudflare Workers
│   ├── migrations/   versioned D1 SQL
│   ├── identity/     the swappable auth seam
│   ├── realtime/     the swappable pub/sub seam
│   └── routes/
└── web/         React + Vite + Material Design 3, on Cloudflare Pages
    ├── api/          every fetch call in the app
    ├── platform/     every browser-only API in the app
    ├── components/
    └── pages/
```

Two seams matter more than the rest, because they are what the Zalo port
replaces — see [Porting to a Zalo Mini App](#porting-to-a-zalo-mini-app).

---

## Local development

Prerequisites: Node 20+ (developed on 24) and a Cloudflare account for
deployment. Local development needs no cloud resources at all — `wrangler dev`
runs D1 and R2 on your machine.

```bash
npm install
```

```bash
cp api/.dev.vars.example api/.dev.vars
```

Create the local database and put one organizer in it:

```bash
npm run db:migrate:local
```

```bash
npm run db:seed:local -w @futsal/api
```

Edit `api/seed.sql` first if you want the organizer to have a real name — that
person is the only one who can add everybody else.

Run both halves:

```bash
npm run dev
```

The API is on `http://localhost:8787` and the app on `http://localhost:5173`.
Vite proxies `/api` to the Worker, so everything is same-origin in development
and there is no CORS to think about. Sign in with the invite code from
`.dev.vars` (`futsal-dev` by default).

Realtime is **off** by default locally — without Upstash credentials the app
falls back to polling every 30 seconds, which is a perfectly good way to
develop. To exercise the realtime path, see [Testing](#testing).

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API + frontend together |
| `npm run typecheck` | All three workspaces |
| `npm test` | Pure-logic tests (no servers needed) |
| `npm run db:migrate:local` | Apply migrations locally |
| `npm run db:migrate:remote` | Apply migrations to the deployed D1 |

---

## Deployment

### 1. Create the Cloudflare resources

```bash
npx wrangler d1 create futsal-friday
```

```bash
npx wrangler r2 bucket create futsal-friday-proofs
```

Copy the `database_id` printed by the first command into
`api/wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

### 2. Apply migrations to the real database

```bash
npm run db:migrate:remote
```

Then create your first organizer — nobody can get in until one exists:

```bash
npx wrangler d1 execute futsal-friday --remote --command "INSERT INTO members (id, name, is_organizer, active, created_at) VALUES ('mem_boss', 'YOUR NAME', 1, 1, datetime('now'));"
```

### 3. Set the secrets

```bash
npx wrangler secret put GROUP_INVITE_CODE
```

```bash
npx wrangler secret put AUTH_SECRET
```

Use something long and random for `AUTH_SECRET` — `openssl rand -base64 32`.
Changing it later signs everybody out, which is also how you revoke access in a
hurry.

Optional, for realtime. Create a free Redis database at
[console.upstash.com](https://console.upstash.com) and set both:

```bash
npx wrangler secret put UPSTASH_REDIS_REST_URL
```

```bash
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

Leave them unset and the app polls instead. Nothing else changes.

### 4. Deploy the Worker

```bash
npm run deploy:api
```

Note the URL it prints (`https://futsal-friday-api.<subdomain>.workers.dev`).

### 5. Deploy the frontend

Point the frontend at that Worker and at its own public URL:

```bash
cp web/.env.example web/.env.local
```

Set `VITE_API_URL` to the Worker URL and `VITE_APP_URL` to the Pages URL, then:

```bash
npm run deploy:web
```

### 6. Close the loop on CORS

Set `WEB_ORIGIN` and `APP_URL` in `api/wrangler.jsonc` to the deployed Pages URL
and redeploy the Worker. Until you do, the browser will refuse the cross-origin
requests.

### Same-origin (recommended if you have a domain)

If you put both behind one hostname — Pages on `futsal.example.com` and a
Worker route on `futsal.example.com/api/*` — you avoid CORS entirely and the
auth cookie becomes first-party, which is strictly better on iOS Safari. Set
`VITE_API_URL=/api` in that case.

---

## Staying inside the free tiers

The app was designed around one number: **Upstash's keepalive cost**. Everything
else has enormous headroom.

### Upstash Redis — the tight one

`@upstash/realtime`'s SSE handler publishes a keepalive **every 10 seconds per
open connection**. That is 360 Redis commands per connection-hour, and it is not
configurable from outside the library.

| Activity | Commands |
| --- | --- |
| One open SSE connection | 360 / hour |
| One event emitted (`XADD` + `EXPIRE` + `PUBLISH`) | 3 |
| One client connecting (`XREVRANGE` replay) | 1 |

A realistic week for 15 players — a burst of registration activity, then a burst
of paying up — is roughly **6,000–7,000 commands a month**, comfortably inside
the 500,000/month free allowance.

The failure mode is a **forgotten browser tab**: at 360/hour, one tab left open
around the clock costs ~260,000 commands a month all by itself. Two of them
exhaust the tier. The client therefore hangs up aggressively
(`web/src/api/realtime.ts`):

- **Page hidden** → close the stream immediately, refresh once on return.
- **Idle 5 minutes** → close the stream, poll every 30s instead. Polling costs
  Worker requests, which are cheap, and *zero* Redis commands.
- **Server-side cap** → a stream is recycled after 10 minutes
  (`SSE_MAX_DURATION_SECS`); the client reconnects transparently.
- Stream history is trimmed to 100 entries and expires after 7 days, so storage
  stays flat without a cleanup job.

If you ever do approach the limit, the cheapest lever is lowering the idle
timeout; the next is swapping the pub/sub module for Durable Object WebSockets,
which the interface is shaped for.

### Workers — 100,000 requests/day

Not a real constraint at this size. The heaviest pattern is polling: one request
per 30 seconds per idle viewer, so twenty people watching for two hours costs
about 4,800 requests. The daily cron is 1.

### D1 — 5 GB, 5M rows read/day, 100k rows written/day

A session with 20 players writes about 45 rows across its whole lifetime.
Reads are indexed and bounded by the roster size. This will not be a limit.

### R2 — 10 GB, no egress fees

Screenshots are resized and re-encoded **in the browser** to a ~150 KB JPEG
before upload (`web/src/platform/web.ts`), and the Worker hard-rejects anything
over 1 MB. Fifteen players every week for a year is roughly 120 MB — about 1% of
the bucket per year.

### Pages — 500 builds/month

Only relevant if you wire up CI to deploy on every push.

> Free-tier limits change. These were correct when written; check the current
> Cloudflare and Upstash pricing pages before relying on the numbers.

---

## How a few things work

### Time

Every timestamp crossing the API is an ISO-8601 UTC instant. Vietnam has been on
a fixed UTC+7 with no daylight saving since 1975, so `shared/src/time.ts` does
the "which Friday is next?" arithmetic with a constant offset rather than a
timezone database. All display and all `datetime-local` inputs are in ICT, so
the organizer edits the time they actually see on the poster even if they are
abroad.

### Money

Amounts are **integer Vietnamese dong** — there are no floats anywhere. The
split uses a largest-remainder allocation at a 1,000d grain, so shares are round
numbers, differ by at most 1,000d, and always sum back to the total exactly. The
split is *derived*, never accumulated: re-settling a session recomputes every
share from the total and the current overrides, so pinning one person's amount
rebalances everyone else and running it twice gives the same answer.

### The cron

`0 1 * * *` — 08:00 ICT, daily. Weekly sessions but a daily trigger, because
both steps are idempotent: a daily run *repairs* a missed trigger instead of
leaving the group without a fixture for a week. It completes finished sessions
(which opens the payment flow on Saturday morning) and creates the upcoming
Friday only if nothing is already scheduled — so an organizer who moved this
week's game to Thursday does not get a duplicate underneath them.

Trigger it locally with:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

### Identity, and how thin it is

This is a private app for about fifteen friends, so the security model is
deliberately small:

1. A shared **invite code** gates everything. Until you enter it, the API will
   not even tell you who is in the group.
2. You then pick your name from the roster and get a signed token (90 days),
   mirrored into an `HttpOnly` cookie for same-origin deployments.

Step 2 is on the honour system — anyone past the gate could claim to be anyone.
That is the right trade here, and it is exactly the part the Zalo port removes.

Worth knowing:

- The invite code is compared in constant time, but there is **no rate limiting**
  on the gate endpoint. Use a code with real entropy, not `futsal`. If you want
  a belt, put a Cloudflare Rate Limiting rule in front of `POST /auth/gate`.
- Tokens are signed, not encrypted; nothing secret is in them. Membership and
  the organizer flag are re-read from the database on **every** request, so
  removing someone or demoting an organizer takes effect immediately rather than
  in 90 days.
- `EventSource` cannot send an `Authorization` header, so the SSE endpoint takes
  a **two-minute, stream-only ticket** in the query string instead of the
  long-lived token — much safer to have sitting in a proxy log.
- Payment screenshots are never linked directly. The R2 key stays server-side
  and images are streamed through a route restricted to the organizer and the
  member who uploaded it.

---

## Porting to a Zalo Mini App

The UI is meant to be reused as-is. Two files are the seam.

**`web/src/platform/index.ts`** declares everything the browser provides:
storage, clipboard, navigation, visibility, image picking, image compression,
object URLs, and the event stream. `web.ts` is the browser implementation and is
the *only* file in the frontend that touches `window`, `document`,
`localStorage`, `navigator` or `EventSource`. Write a `zmp.ts` alongside it —
`setStorage`/`getStorage`, `setClipboardData`, `chooseImage`, ZMP's router — and
change the one export at the bottom of `index.ts`.

**`web/src/api/`** holds every network call, as plain `fetch`. If ZMP requires
its own request API, `request()` in `client.ts` is the single function to
rewrite.

On the server, `api/src/identity/index.ts` defines an `IdentityProvider`
interface. The Zalo version verifies a ZMP access token and maps it to
`members.external_id` — a column that already exists in migration 0001 for
exactly this. No route, query or component changes.

Things to know before you start: this app deliberately avoids React Router (its
whole job is wrapping the History API, which ZMP replaces), uses no webfonts and
no icon font, and keeps all realtime behind `PubSub` so it can become
WebSockets if ZMP's SSE support disappoints.

---

## Testing

```bash
npm test
```

Pure-logic tests, no servers required: `shared/test/logic.test.ts` covers the
ICT date arithmetic (including the UTC-vs-ICT boundary cases where a Thursday
evening in UTC is already Friday in Ho Chi Minh City) and the money split
(exact-sum invariants, overrides, rounding).

The API integration suite is 62 checks against real local D1 and R2 — the invite
gate, the waitlist and its auto-promotion, the split, the payment state machine,
proof upload and access control, and the cron. It needs `wrangler dev` running
and writes to the local database, so run it in a second terminal:

```bash
npm run dev:api
```

```bash
npm run test:api
```

### Browser tests

These drive headless Chrome over the DevTools Protocol — no Playwright, no
Puppeteer. They need both dev servers up, and put screenshots in `/tmp/ff-shots`.

```bash
npm run test:ui -w @futsal/web
```

```bash
npm run test:payments -w @futsal/web
```

Set `CHROME_PATH` if Chrome is not at the macOS default location.

### Testing realtime without an Upstash account

`web/test/fake-upstash.mjs` implements just enough of the Upstash REST protocol
(`XADD`, `EXPIRE`, `PUBLISH`, `XREVRANGE`, and the SSE `SUBSCRIBE` endpoint) to
exercise the whole realtime path locally.

```bash
npm run fake-upstash -w @futsal/web
```

Add these to `api/.dev.vars` and restart the Worker:

```
UPSTASH_REDIS_REST_URL=http://localhost:9999
UPSTASH_REDIS_REST_TOKEN=faketoken
```

Then:

```bash
npm run test:realtime -w @futsal/web
```

That opens two independent browsers on the same session, registers in one, and
asserts the other updates without a reload. Since the polling fallback is 30
seconds, anything arriving faster can only have come over SSE — it currently
propagates in about 250 ms.

---

## Known limitations

- **No rate limiting on the invite gate.** Use a strong code, or add a
  Cloudflare Rate Limiting rule.
- **Name picking is unauthenticated** past the invite code. Intentional; see
  above.
- **The realtime keepalive is the library's, not ours.** If Upstash usage ever
  becomes a problem, the client's idle timeout is the first knob and the
  `PubSub` interface is the escape hatch.
- **Sessions are keyed by kickoff time** — a partial unique index prevents two
  non-cancelled sessions starting at the same instant. Two games in one evening
  need different start times.
- **Deleting is always soft.** Members and venues are deactivated, never
  removed, so past registrations and payments keep their meaning.
