# Futsal Friday

A small web app for a group of friends who play futsal every Friday at 19:30
(Asia/Ho_Chi_Minh). It replaces the two things the organizer currently does by
hand: posting the registration list in the group chat, and chasing everyone for
their share of the pitch fee.

An installable PWA that runs entirely on free tiers — Cloudflare Workers, D1,
R2, Pages, and Upstash Redis. Add it to your Home Screen and it sends a push
reminder before kickoff, and a nudge when you still owe for the pitch.
Available in English and Burmese (မြန်မာ).

**Live deployment**

| | |
| --- | --- |
| App | https://futsal-friday.pages.dev |
| API | https://futsal-friday-api.chanyeintun.workers.dev |
| D1 | `futsal-friday` (APAC) |
| R2 | `futsal-friday-proofs` |
| Upstash | `futsal-friday` (Singapore, free tier) |
| Cron | `0 * * * *` — hourly |
| Push | VAPID configured; reminders live |

Getting in is by personal invite link — see [Who can get in](#who-can-get-in).

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
- **Installable, with reminders.** A PWA that opens offline, plus push
  notifications ~3h before kickoff and a weekly nudge while you still owe.
- **English and Burmese.** Including the push notifications and the text you
  copy into the group chat.

---

## Layout

```
futsal-friday/
├── shared/      types, zod schemas, and pure helpers used by both sides
│   ├── models.ts     domain models + request validation
│   ├── events.ts     the six realtime events, defined once
│   ├── i18n/         message catalogues; English is the source of truth
│   ├── time.ts       Asia/Ho_Chi_Minh arithmetic, localised names
│   ├── money.ts      integer-dong splitting
│   └── summary.ts    the chat-pasteable text
├── api/         Hono on Cloudflare Workers
│   ├── migrations/   versioned D1 SQL
│   ├── identity/     the swappable auth seam
│   ├── realtime/     the swappable pub/sub seam
│   ├── push/         VAPID + RFC 8291 Web Push, on WebCrypto
│   └── routes/
└── web/         React + Vite + Material Design 3, on Cloudflare Pages
    ├── api/          every fetch call in the app
    ├── platform/     every browser-only API in the app
    ├── public/       manifest, service worker, icons
    ├── components/
    └── pages/
```

`web/platform/` is where every browser-only API lives — storage, clipboard,
navigation, the Push API, image capture. Components never touch `window` or
`navigator` directly, which is what keeps the awkward parts (iOS push rules,
clipboard in webviews, canvas compression) in one reviewable file.

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
and there is no CORS to think about.

To sign in locally, mint yourself a link:

```bash
npm run claim:bootstrap -w @futsal/api -- mem_organizer --local
```

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
npx wrangler d1 execute futsal-friday --remote --command "INSERT INTO members (id, name, is_organizer, active, created_at) VALUES ('mem_boss', 'YOUR NAME', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));"
```

Once the Worker and frontend are up, mint yourself a link to sign in with:

```bash
npm run claim:bootstrap -w @futsal/api -- mem_boss
```

### 3. Set the secrets

```bash
npx wrangler secret put AUTH_SECRET
```

Use something long and random — `openssl rand -base64 32`. Changing it later
signs everybody out, which is one way to revoke access in a hurry (the targeted
way is per-member, below).

Optional, for realtime. Create a free Redis database at
[console.upstash.com](https://console.upstash.com) and set both:

```bash
npx wrangler secret put UPSTASH_REDIS_REST_URL
```

```bash
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

Leave them unset and the app polls instead. Nothing else changes.

Optional, for push reminders — see
[Setting it up](#setting-it-up) for the full flow:

```bash
npm run push:keys -w @futsal/api
```

### 4. Deploy the Worker

```bash
npm run deploy:api
```

Note the URL it prints (`https://futsal-friday-api.<subdomain>.workers.dev`).

### 5. Deploy the frontend

Point the frontend at that Worker and at its own public URL:

```bash
cp web/.env.example web/.env.production
```

Set `VITE_API_URL` to the Worker URL and `VITE_APP_URL` to the Pages URL, then:

Use `.env.production`, not `.env.local` — Vite reads `.env.local` in *every*
mode including `vite dev`, which would quietly point local development at the
deployed API, which is rarely what you want while developing.

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

### Web Push — free, but subrequest-bounded

Push costs nothing: notifications go straight from the Worker to Google's,
Mozilla's or Apple's push service. The limit that matters is **subrequests per
Worker invocation** — one HTTP request per subscribed device. Fifteen players
with two devices each is 30, well inside the cap, and the hourly cron only sends
anything at all in the hour before a game or when somebody owes money. If the
group ever grew past that, the fix is to send in batches across ticks rather
than all in one.

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

`0 * * * *` — hourly. Reminders are why: "three hours before kickoff" cannot be
hit by a once-a-day job. Every step is idempotent, so extra runs are harmless
and a missed run self-heals.

The session bookkeeping inside it still only runs at 08:00 ICT: it completes
finished sessions (which opens the payment flow on Saturday morning) and creates
the upcoming Friday only if nothing is already scheduled — so an organizer who
moved this week's game to Thursday does not get a duplicate underneath them.

8,760 invocations a year is noise against 100k requests/day.

Trigger it locally with:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

### Who can get in

The only way in is a **single-use link**, sent to one person.

The organizer opens **Setup**, taps *Copy link* next to a name, and sends it to
that person directly. Opening it signs them in as that member and spends the
link; forwarding it afterwards does nothing. Nobody has a password, and the app
never shows a list of who is in the group to anyone who is not already in it.

This replaced a shared invite code plus a "pick who you are" screen. That was
too weak in a way that only looks small until you think about money: anyone
holding the code — which lives in a group chat forever — could pick *any* name
on the roster, including an organizer's, and inherit the ability to settle
bills, confirm payments and remove members. Two taps to full admin.

Worth knowing:

- **A link is a bearer credential.** Whoever opens it first becomes that person,
  so send it one-to-one, not to the group. It expires after 7 days, and issuing
  a new one for the same member invalidates the old one.
- **The secret travels in the URL fragment** (`/claim#…`), which browsers never
  send to the server — so it stays out of access logs, proxy logs and `Referer`
  headers. The page reads it, posts it once, and strips it from the address bar.
- **It is a random 256-bit value looked up in the database**, not a signed
  token. That makes single-use a delete rather than a revocation list, and lets
  the bootstrap path mint one with a single SQL statement and no secrets.
- **Lost phone?** *Sign out their devices* on the roster bumps that member's
  `token_version`, which invalidates every session token they hold — session
  tokens are stateless and otherwise last 90 days. Then send a new link.
- **Second device?** Anyone can mint a link for themselves under **Setup → Add
  another device**, without waiting on the organizer. That is not a privilege
  escalation: they already have the access they are copying.
- **Membership and role are re-read on every request**, so removing someone or
  demoting an organizer takes effect immediately.
- **`EventSource` cannot send an `Authorization` header**, so the SSE endpoint
  takes a two-minute, stream-only ticket in its query string instead of the
  long-lived token.

#### Locked out

If nobody can sign in — the first organizer, or one who lost their only device —
mint a link straight from the database. It needs no secrets:

```bash
npm run claim:bootstrap -w @futsal/api -- <memberId>
```

Find the id with:

```bash
npx wrangler d1 execute futsal-friday --remote --command "SELECT id, name FROM members;"
```

---

## Installing it, and reminders

The app is a PWA: installable to a Home Screen, opens offline, and can send
push notifications.

### Installing

- **Android / Chrome** — the browser offers "Install app" on its own.
- **iPhone / Safari** — Share, then *Add to Home Screen*.
- **Desktop** — the install icon in the address bar.

Once installed it launches without browser chrome, and the app shell is cached,
so it opens instantly and still renders the last state with no signal. Data
still needs the network; the service worker deliberately never caches API
responses, because a stale registration list is worse than a spinner.

### Reminders

Two notifications, both sent by the hourly cron:

| | When | Who |
| --- | --- | --- |
| **Match reminder** | ~3h before kickoff (`REMINDER_LEAD_HOURS`) | Everyone registered as playing — not the waitlist |
| **Unpaid nudge** | Once a day has passed since a settled session, then at most weekly | Anyone whose payment is still `unpaid` |

Members turn reminders on per device under **Setup**, and can switch each kind
off independently. Enabling on a phone does not disable the laptop — they are
separate subscriptions against one shared preference.

Both are idempotent. Every send first claims a row in `notifications` with a
unique `dedupe_key`; a cron that fires twice, or a retry after a partial
failure, sends nothing extra. The key is what defines "the same notification":
`session_reminder:<session_id>` fires once ever, while
`payment_due:<session_id>:<ISO week>` recurs weekly so a debt becomes a gentle
nag rather than a daily one.

### The iPhone caveat

**iOS only delivers Web Push to an app installed on the Home Screen.** In a
normal Safari tab the APIs are not even defined. The app detects this and shows
Add-to-Home-Screen instructions instead of a permission toggle that could not
work — but it is the thing to tell the group when reminders "don't work on my
iPhone". Requires iOS 16.4 or newer.

### How push is implemented

There is no `web-push` dependency: that package is Node-only. VAPID (RFC 8292)
and the `aes128gcm` payload encryption (RFC 8291) are implemented directly on
WebCrypto in `api/src/push/crypto.ts`, which is about 150 lines of
well-specified key derivation.

Correctness is not taken on trust. `npm run test:push -w @futsal/api` runs the
worked example from RFC 8291 Appendix A — the specification's own fixed keys,
salt and plaintext — through the encryptor and compares the entire body byte
for byte, then checks that a generated VAPID JWT verifies under its advertised
public key. A mistake in the key derivation fails there, rather than becoming
notifications that silently never arrive.

Dead subscriptions clean themselves up: a `404` or `410` from the push service
means the endpoint is gone for good and the row is deleted; softer failures
increment a counter and are dropped after five.

### Setting it up

```bash
npm run push:keys -w @futsal/api
```

Put the private key and subject in the Worker, and the public key in the
frontend build:

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
```

```bash
npx wrangler secret put VAPID_SUBJECT
```

That is all — the frontend fetches the application server key from
`GET /push/status` rather than baking it in, so there is nothing to keep in sync
and no frontend rebuild needed. Rotating the keypair invalidates every existing
subscription, so do it once.

Leave the keys unset and everything else still works — the UI simply shows
"Reminders: not configured" rather than a dead toggle.

### Regenerating the icons

`web/scripts/icon.svg` is the source art. `npm run icons -w @futsal/web` renders
it to the PNG sizes the manifest needs via headless Chrome, so there is no image
library in the dependency tree. The PNGs are committed; this only needs running
when the artwork changes.

---


## Languages

English and Burmese (မြန်မာ). The switcher is under **Setup**, and also on the
sign-in screen — nobody should have to read a language they do not speak in
order to find the language switch.

### How the language is chosen

In order:

1. **An explicit choice on this device.** Always wins, and applies before any
   network request.
2. **The device's own language, when it is not English.** A phone set to
   Burmese opens in Burmese.
3. **The member's stored choice**, so switching on a phone carries over to a
   laptop whose system language is English.
4. English.

Step 2 sits above step 3 on purpose. `members.language` defaults to `'en'` for
a row the organizer created before that person ever opened the app, so the
server cannot tell "chose English" apart from "never chose". Letting that
default outrank device detection meant a Burmese phone opened in English — a
bug this project shipped once and caught in production.

The choice is stored on the device *and* sent to the server, because push
notification text is written server-side: the browser that picked the language
is asleep when the reminder goes out. Each member's reminders arrive in their
own language, even within the same group.

### How the catalogue works

There is no i18n library. `shared/src/i18n/en.ts` is a plain nested object and
every other locale is declared as `typeof en`, so a missing key is a build
error. Strings that take values are functions rather than templates with
placeholders — `m.session.playing(5, 14)` is checked by the compiler, whereas
`t('session.playing', { count })` is not, and its parameter names rot silently.

Two conventions in `my.ts` worth not "fixing":

- **Unicode, not Zawgyi.** The two encodings share the Myanmar block and look
  identical in an editor, but Zawgyi renders as garbage on any modern phone.
  The test suite fails the build if Zawgyi-only codepoints appear.
- **Arabic numerals.** Times, counts and money stay `19:30` and `120.000d`
  rather than Myanmar digits — what Myanmar apps overwhelmingly do, and it
  keeps amounts unambiguous next to the Vietnamese dong.

Burmese also gets its own typography rules in `styles.css`. The script stacks
diacritics above and below the baseline, so it needs a taller line height or
they clip; and it is written without spaces between words, so a long string has
no break opportunity and will push a flex row wider than the screen unless
`overflow-wrap` is relaxed.

> The Burmese here was not written by a native speaker. It passes the automated
> checks and reads plausibly, but give it a review before the group relies on
> it — `shared/src/i18n/my.ts` is a single file and easy to edit.

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

### Push

```bash
npm run test:push -w @futsal/api
```

`npm test` also checks the catalogues: that Burmese has every English key, that
no entry was left as the English string, that every translated string actually
contains Myanmar script, that no Zawgyi codepoints crept in, and that
interpolated values survive into the translated form.

RFC conformance, no servers needed: the worked example from RFC 8291 Appendix A
is encrypted with the specification's own fixed keys and salt and compared byte
for byte, and a generated VAPID JWT is verified under its advertised public key.

```bash
npm run test:push:flow -w @futsal/api
```

The full flow against `wrangler dev`. It stands up a local HTTP server
impersonating a push service, subscribes with a real generated P-256 keypair,
and **decrypts what the Worker sends** back to the original JSON — so the
ephemeral-key path is exercised, not just the fixed RFC vector. It then checks
the reminder window, that a second cron run sends nothing, the unpaid nudge and
its weekly dedupe, and that a `410` endpoint is deleted.

Add VAPID keys to `api/.dev.vars` first, or it will tell you push is disabled.

### Browser tests

These drive headless Chrome over the DevTools Protocol — no Playwright, no
Puppeteer. They put screenshots in `/tmp/ff-shots`.

```bash
npm run test:ui -w @futsal/web
```

```bash
npm run test:payments -w @futsal/web
```

Both need `npm run dev` running.

```bash
npm run test:pwa -w @futsal/web
```

```bash
npm run test:burmese -w @futsal/web
```

Runs the app in a browser reporting a Burmese device language and checks what a
catalogue test cannot: that auto-detection picks Burmese, that Myanmar script
renders without clipping its stacked diacritics, that a script with no
inter-word spaces does not overflow any container, and that switching language
persists. Point it at a deployment with `APP_URL` and `INVITE_CODE`.

Checks the manifest, service worker registration, shell caching, that the app
still renders with the network cut, and that the worker can raise a
notification. This one runs against `vite preview` on port 4173, not the dev
server — offline needs the real built output, because the dev server serves
unbundled modules the worker deliberately never caches.

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

- **A claim link is a bearer credential.** Anyone who sees it before its
  intended recipient can use it. Send links one-to-one, never to the group.
- **The realtime keepalive is the library's, not ours.** If Upstash usage ever
  becomes a problem, the client's idle timeout is the first knob and the
  `PubSub` interface is the escape hatch.
- **Sessions are keyed by kickoff time** — a partial unique index prevents two
  non-cancelled sessions starting at the same instant. Two games in one evening
  need different start times.
- **Deleting is always soft.** Members and venues are deactivated, never
  removed, so past registrations and payments keep their meaning.
- **iOS needs the app installed** before it will deliver any push. There is no
  way around this; the UI explains it rather than offering a toggle that cannot
  work.
- **The Burmese is unreviewed by a native speaker.** See above.
- **Reminders are best-effort.** A phone that is off when the push service gives
  up retrying (`TTL`) simply misses that reminder — deliberately, since a
  "kickoff in 3h" notification arriving tomorrow is worse than none.
