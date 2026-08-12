/**
 * End-to-end smoke test against a running `wrangler dev`.
 *
 *   npm run dev -w @futsal/api        # terminal 1
 *   npm run test -w @futsal/api       # terminal 2
 *
 * Exercises the whole backend against real D1 and R2: the invite gate, the
 * waitlist and its auto-promotion, the money split, the payment state machine,
 * proof upload/retrieval, and the cron. It writes to the local database, so
 * point it at a dev instance only.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const BASE = process.env.API_URL ?? 'http://localhost:8787';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? '' : `\n         ${JSON.stringify(detail)}`}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

async function call(method, path, { token, body, raw, contentType } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (contentType) headers['Content-Type'] = contentType;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, body: json, headers: response.headers };
}

/** The nonce out of a claim URL's fragment. */
const nonceOf = (url) => url.split('#')[1];

/**
 * Bootstrap: write a claim nonce straight into the local database.
 *
 * This is the documented escape hatch for the first organizer, who by
 * definition cannot be invited from inside the app. Everyone else in this
 * suite is invited through the real API.
 */
function seedClaimNonce(memberId) {
  const nonce = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 3600_000).toISOString();
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--command',
    `UPDATE members SET claim_nonce='${nonce}', claim_expires_at='${expires}' WHERE id='${memberId}';`],
    { encoding: 'utf8', stdio: 'pipe' });
  return nonce;
}

/** Run arbitrary SQL against the local dev database. */
function sql(command) {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--command', command],
    { encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Fabricate a past attendance record.
 *
 * The streak *maths* is unit-tested in /shared; what needs proving here is the
 * query that feeds it, which is where the judgement calls live — a cancelled
 * session must not count, a game from before you joined must not count, and a
 * session with no registration row at all must count as a miss rather than
 * being skipped.
 */
function seedPastSessions(memberId, plan, venueId) {
  // Previous runs left their own seeds behind, and they land in the same
  // "recent hours" window — so they would both skew this member's streak and
  // crowd the real sessions out of the list the cron check reads.
  // Registrations go with them via ON DELETE CASCADE.
  sql(`DELETE FROM sessions WHERE id LIKE 'ses_streak_%';`);
  seedPastSessions.windowStart = new Date(
    Date.now() - (plan.length + 1) * 3_600_000 - 60_000,
  ).toISOString();
  // And anything *else* sitting in the window we are about to claim.
  //
  // The streak is computed over every session between the member's join date
  // and now, not merely the ones seeded here — so a past session left behind
  // by another suite (the browser tests seed `ses_test_%` ones and only clean
  // up at their own exit) lands inside the window with no registration row and
  // reads as a missed game. That shifts `current` and `total` by one and makes
  // this fixture depend on what ran before it.
  sql(
    `DELETE FROM sessions
      WHERE starts_at >= '${seedPastSessions.windowStart}'
        AND starts_at < '${new Date().toISOString()}';`,
  );
  // Hours ago, not weeks: the suite creates its own past sessions, and those
  // would otherwise sit *after* the seeded ones and read as misses. Owning the
  // most recent slice of history is what makes the assertions deterministic —
  // the member's join date is then set to just before this window so nothing
  // else is inside it.
  const base = Date.now() - (plan.length + 1) * 3_600_000;
  plan.forEach((entry, index) => {
    const startsAt = new Date(base + index * 3_600_000).toISOString();
    const sessionId = `ses_streak_${index}_${Date.now() % 100000}`;
    sql(`INSERT INTO sessions (id, venue_id, starts_at, status, max_players, created_at, updated_at)
         VALUES ('${sessionId}', ${venueId ? `'${venueId}'` : 'NULL'}, '${startsAt}',
                 '${entry === 'cancelled' ? 'cancelled' : 'completed'}', 12, '${startsAt}', '${startsAt}');`);
    // `noshow` is a registration that says "in" with attendance saying
    // otherwise — the case the whole feature exists for.
    const registered =
      entry === 'in' || entry === 'waitlist' ? entry : entry === 'noshow' ? 'in' : null;
    if (registered) {
      sql(`INSERT INTO registrations
             (id, session_id, member_id, status, position, created_at, attended)
           VALUES ('reg_streak_${index}_${Date.now() % 100000}', '${sessionId}', '${memberId}',
                   '${registered}', ${index}, '${startsAt}',
                   ${entry === 'noshow' ? 0 : 'NULL'});`);
    }
  });
}

/**
 * The whole roster, following the cursor.
 *
 * `/members` is paginated, so "is this person in the roster" cannot be
 * answered by the first page once a group is bigger than one — which a dev
 * database reaches long before a real group does.
 */
async function allMembers(token) {
  const members = [];
  let cursor = null;
  // Bounded: a runaway cursor should fail the test, not spin forever.
  for (let page = 0; page < 50; page++) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const res = await call('GET', `/members${query}`, { token });
    if (res.status !== 200) break;
    members.push(...(res.body?.members ?? []));
    cursor = res.body?.nextCursor ?? null;
    if (!cursor) break;
  }
  return members;
}

/** Follow any cursor endpoint to the end, collecting one field. */
async function walk(token, path, field) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 60; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await call('GET', `${path}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ''}`, { token });
    if (res.status !== 200) break;
    out.push(...(res.body?.[field] ?? []));
    cursor = res.body?.nextCursor ?? null;
    if (!cursor) break;
  }
  return out;
}

/** Creates a member (as organizer), invites them, and redeems the link. */
async function addAndLogIn(organizerToken, name) {
  const created = await call('POST', '/members', { token: organizerToken, body: { name } });
  if (created.status !== 201) throw new Error(`could not create ${name}: ${JSON.stringify(created.body)}`);

  const link = await call('POST', `/members/${created.body.member.id}/claim-link`, { token: organizerToken });
  if (link.status !== 200) throw new Error(`no link for ${name}: ${JSON.stringify(link.body)}`);

  const claimed = await call('POST', '/auth/claim', { body: { nonce: nonceOf(link.body.url) } });
  if (!claimed.body?.token) throw new Error(`could not claim ${name}: ${JSON.stringify(claimed.body)}`);

  return { id: created.body.member.id, name, token: claimed.body.token };
}

const run = async () => {
  const stamp = Date.now();

  section('health');
  const health = await call('GET', '/health');
  check('health responds', health.status === 200 && health.body.ok === true, health.body);

  const noAuth = await call('GET', '/sessions');
  check('protected routes need a token', noAuth.status === 401, noAuth.body);

  section('claim links are the only way in');
  const rosterLeak = await call('GET', '/members');
  check('the roster is not readable without a token', rosterLeak.status === 401, rosterLeak.status);

  const bogus = await call('POST', '/auth/claim', { body: { nonce: 'x'.repeat(40) } });
  check('an unknown nonce is refused', bogus.status === 401, bogus.body);
  check('and does not say why', /not valid any more/.test(bogus.body?.error?.message ?? ''),
    bogus.body?.error?.message);

  // The first organizer cannot be invited from inside the app, so they are
  // bootstrapped straight against the database — the documented escape hatch.
  const organizerId = 'mem_organizer';
  const bootstrapNonce = seedClaimNonce(organizerId);
  const claimed = await call('POST', '/auth/claim', { body: { nonce: bootstrapNonce } });
  check('bootstrap link signs the organizer in', claimed.status === 200 && !!claimed.body.token,
    JSON.stringify(claimed.body).slice(0, 140));
  check('claim returns the identity', claimed.body?.identity?.isOrganizer === true, claimed.body?.identity);
  const organizer = claimed.body.token;

  const replay = await call('POST', '/auth/claim', { body: { nonce: bootstrapNonce } });
  check('a link is single-use', replay.status === 401, replay.body);

  const me = await call('GET', '/auth/me', { token: organizer });
  check('/auth/me reflects the organizer', me.body?.identity?.isOrganizer === true, me.body);

  section('venues');
  const venue = await call('POST', '/venues', {
    token: organizer,
    body: { name: `Pitch ${stamp}`, address: '1 Test St', priceNote: '600.000d/hour' },
  });
  check('organizer creates a venue', venue.status === 201, venue.body);
  const venueId = venue.body.venue.id;

  section('members + role enforcement');
  const alice = await addAndLogIn(organizer, `Alice ${stamp}`);
  const bob = await addAndLogIn(organizer, `Bob ${stamp}`);
  const carol = await addAndLogIn(organizer, `Carol ${stamp}`);

  const duplicate = await call('POST', '/members', { token: organizer, body: { name: `Alice ${stamp}` } });
  check('duplicate member names are refused', duplicate.status === 409, duplicate.body);

  const forbidden = await call('POST', '/venues', { token: alice.token, body: { name: 'Sneaky' } });
  check('non-organizers cannot create venues', forbidden.status === 403, forbidden.body);

  // Deliberately not organizer-only. The unpaid list is already pasted into
  // the group chat by the copy-status button, and being on it in public is
  // what the feature is for.
  const balancesForMember = await call('GET', '/members/balances', { token: alice.token });
  check('any member can see who owes what', balancesForMember.status === 200,
    balancesForMember.status);
  check('and it names names', Array.isArray(balancesForMember.body?.balances) &&
    balancesForMember.body.balances.length > 0,
    JSON.stringify(balancesForMember.body).slice(0, 120));
  const balancesAnon = await call('GET', '/members/balances');
  check('but not without signing in', balancesAnon.status === 401, balancesAnon.status);

  section('sessions + waitlist');
  const startsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const session = await call('POST', '/sessions', {
    token: organizer,
    body: { startsAt, venueId, feePerPerson: 70_000, maxPlayers: 2 },
  });
  check('organizer creates a session', session.status === 201, session.body);
  const sessionId = session.body.session.id;

  const clash = await call('POST', '/sessions', { token: organizer, body: { startsAt, venueId } });
  check('two sessions cannot share a kickoff', clash.status === 409, clash.body);

  const r1 = await call('POST', `/sessions/${sessionId}/register`, { token: alice.token });
  check('first player is in', r1.body?.registration?.status === 'in', r1.body);

  const again = await call('POST', `/sessions/${sessionId}/register`, { token: alice.token });
  check('registering twice is idempotent', again.status === 200 && again.body.changed === false, again.body);

  const r2 = await call('POST', `/sessions/${sessionId}/register`, { token: bob.token });
  check('second player is in', r2.body?.registration?.status === 'in', r2.body);

  const r3 = await call('POST', `/sessions/${sessionId}/register`, { token: carol.token });
  check('third player hits the cap and waits', r3.body?.registration?.status === 'waitlist', r3.body);
  check('counts reflect the waitlist', r3.body?.counts?.in === 2 && r3.body?.counts?.waitlist === 1, r3.body);

  const detail = await call('GET', `/sessions/${sessionId}`, { token: carol.token });
  check('detail lists players in registration order',
    detail.body.registrations.map((r) => r.memberName).join('|') === `${alice.name}|${bob.name}|${carol.name}`,
    detail.body.registrations);
  check('detail marks the caller', detail.body.me?.memberId === carol.id, detail.body.me);
  check('registration is open before kickoff', detail.body.registrationOpen === true);

  const withdraw = await call('DELETE', `/sessions/${sessionId}/register`, { token: alice.token });
  check('withdrawal promotes the waitlist head', withdraw.body?.promoted?.memberId === carol.id, withdraw.body);
  check('counts stay at the cap after promotion',
    withdraw.body?.counts?.in === 2 && withdraw.body?.counts?.waitlist === 0, withdraw.body);

  // Alice comes back — she should land at the back, on the waitlist.
  const rejoin = await call('POST', `/sessions/${sessionId}/register`, { token: alice.token });
  check('re-registering goes to the back of the queue', rejoin.body?.registration?.status === 'waitlist', rejoin.body);

  section('raising the cap promotes automatically');
  const raised = await call('PATCH', `/sessions/${sessionId}`, { token: organizer, body: { maxPlayers: 3 } });
  check('cap raised', raised.status === 200 && raised.body.session.maxPlayers === 3, raised.body);
  const afterRaise = await call('GET', `/sessions/${sessionId}`, { token: organizer });
  check('waitlist drains when the cap grows',
    afterRaise.body.counts.in === 3 && afterRaise.body.counts.waitlist === 0, afterRaise.body.counts);

  section('settlement + money split');
  const settle = await call('POST', `/sessions/${sessionId}/settle`, {
    token: organizer,
    body: { totalCharge: 500_000 },
  });
  check('organizer settles the session', settle.status === 200, settle.body);
  const amounts = settle.body.payments.map((p) => p.amountDue).sort((a, b) => b - a);
  check('split sums to the total exactly',
    amounts.reduce((a, b) => a + b, 0) === 500_000, amounts);
  check('shares are round and near-equal',
    JSON.stringify(amounts) === JSON.stringify([167_000, 167_000, 166_000]), amounts);
  check('settling completes the session', settle.body.totalCharge === 500_000);

  const memberSettle = await call('POST', `/sessions/${sessionId}/settle`, {
    token: bob.token, body: { totalCharge: 1 },
  });
  check('members cannot settle', memberSettle.status === 403, memberSettle.body);

  section('per-person override rebalances everyone');
  const bobPayment = settle.body.payments.find((p) => p.memberId === bob.id);
  const override = await call('PATCH', `/payments/${bobPayment.id}/override`, {
    token: organizer, body: { amount: 200_000 },
  });
  check('override applied', override.status === 200, override.body);
  const afterOverride = override.body.payments;
  check('overridden amount is exact',
    afterOverride.find((p) => p.memberId === bob.id).amountDue === 200_000, afterOverride);
  check('total still balances after override',
    afterOverride.reduce((sum, p) => sum + p.amountDue, 0) === 500_000, afterOverride);

  section('payment claim -> confirm');
  const claim = await call('POST', `/sessions/${sessionId}/payments/me/claim`, {
    token: bob.token, body: { note: 'transferred' },
  });
  check('member claims payment', claim.body?.payment?.status === 'pending', claim.body);

  const unclaim = await call('DELETE', `/sessions/${sessionId}/payments/me/claim`, { token: bob.token });
  check('member can undo a claim', unclaim.body?.payment?.status === 'unpaid', unclaim.body);

  // Upload a proof image, then claim with it attached.
  const png = Uint8Array.from(atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  ), (ch) => ch.charCodeAt(0));
  const upload = await call('POST', `/uploads/proof?sessionId=${sessionId}`, {
    token: bob.token, raw: png, contentType: 'image/png',
  });
  check('proof uploads to R2', upload.status === 201 && !!upload.body.key, upload.body);

  const badType = await call('POST', `/uploads/proof?sessionId=${sessionId}`, {
    token: bob.token, raw: png, contentType: 'application/pdf',
  });
  check('non-image uploads are refused', badType.status === 400, badType.body);

  const claimWithProof = await call('POST', `/sessions/${sessionId}/payments/me/claim`, {
    token: bob.token, body: { proofKey: upload.body.key },
  });
  check('claim records the proof', claimWithProof.body?.payment?.hasProof === true, claimWithProof.body);

  const proofAsStranger = await call('GET', `/payments/${bobPayment.id}/proof`, { token: carol.token });
  check('others cannot read a proof', proofAsStranger.status === 403, proofAsStranger.status);

  const proofAsOrganizer = await call('GET', `/payments/${bobPayment.id}/proof`, { token: organizer });
  check('organizer can read the proof', proofAsOrganizer.status === 200, proofAsOrganizer.status);

  const reject = await call('POST', `/payments/${bobPayment.id}/review`, {
    token: organizer, body: { decision: 'reject', reason: 'wrong amount' },
  });
  check('rejection returns to unpaid', reject.body?.payment?.status === 'unpaid', reject.body);
  check('rejection keeps the reason', reject.body?.payment?.rejectReason === 'wrong amount', reject.body);
  check('rejection keeps the screenshot', reject.body?.payment?.hasProof === true, reject.body);

  await call('POST', `/sessions/${sessionId}/payments/me/claim`, { token: bob.token, body: {} });
  const confirm = await call('POST', `/payments/${bobPayment.id}/review`, {
    token: organizer, body: { decision: 'confirm' },
  });
  check('confirmation sticks', confirm.body?.payment?.status === 'confirmed', confirm.body);

  const reclaim = await call('POST', `/sessions/${sessionId}/payments/me/claim`, {
    token: bob.token, body: {},
  });
  check('a confirmed payment cannot be re-claimed', reclaim.status === 409, reclaim.body);

  section('dashboards');
  const summary = await call('GET', `/sessions/${sessionId}/payments`, { token: organizer });
  check('collected matches the confirmed payment', summary.body.collected === 200_000, summary.body);
  check('outstanding is the rest', summary.body.outstanding === 300_000, summary.body);

  // Walked, not read: the debt list is paged and ordered by what is owed, so
  // somebody square with the group sits far past the first page.
  const balances = { body: { balances: await walk(organizer, '/members/balances?limit=100', 'balances') } };
  const bobBalance = balances.body.balances.find((b) => b.member.id === bob.id);
  check('balance shows nothing outstanding for Bob', bobBalance?.outstanding === 0, bobBalance);
  const aliceBalance = balances.body.balances.find((b) => b.member.id === alice.id);
  check('balance shows what Alice still owes', aliceBalance?.outstanding > 0, aliceBalance);

  const history = await call('GET', `/members/${bob.id}/history`, { token: bob.token });
  check('member sees their own history', history.status === 200 && history.body.history.length > 0, history.body);
  const spying = await call('GET', `/members/${bob.id}/history`, { token: carol.token });
  check('members cannot read each other\'s history', spying.status === 403, spying.status);

  section('registration closes at kickoff');
  const pastStart = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const past = await call('POST', '/sessions', { token: organizer, body: { startsAt: pastStart, venueId } });
  const lateJoin = await call('POST', `/sessions/${past.body.session.id}/register`, { token: alice.token });
  check('cannot register after kickoff', lateJoin.status === 409, lateJoin.body);
  check('closure has its own error code',
    lateJoin.body?.error?.code === 'registration_closed', lateJoin.body);

  section('claim link authority');
  const aliceLink = await call('POST', `/members/${bob.id}/claim-link`, { token: alice.token });
  check('a member cannot mint a link for someone else', aliceLink.status === 403, aliceLink.body);

  const ownLink = await call('POST', '/auth/my-device-link', { token: alice.token });
  check('but can mint one for her own second device', ownLink.status === 200 && !!ownLink.body.url,
    JSON.stringify(ownLink.body).slice(0, 100));
  check('the link points at /claim with the nonce in the fragment',
    /\/claim#[A-Za-z0-9_-]{40,}$/.test(ownLink.body?.url ?? ''), ownLink.body?.url);

  const secondDevice = await call('POST', '/auth/claim', { body: { nonce: nonceOf(ownLink.body.url) } });
  check('the second device signs in as the same person',
    secondDevice.body?.identity?.memberId === alice.id, secondDevice.body?.identity);
  check('the first device still works',
    (await call('GET', '/auth/me', { token: alice.token })).status === 200);

  // Re-issuing must invalidate whatever was outstanding, or "resend it" would
  // leave two live links for one identity.
  const first = await call('POST', `/members/${carol.id}/claim-link`, { token: organizer });
  const second = await call('POST', `/members/${carol.id}/claim-link`, { token: organizer });
  const stale = await call('POST', '/auth/claim', { body: { nonce: nonceOf(first.body.url) } });
  check('re-issuing invalidates the previous link', stale.status === 401, stale.body);
  const fresh = await call('POST', '/auth/claim', { body: { nonce: nonceOf(second.body.url) } });
  check('the newest link still works', fresh.status === 200, fresh.body);

  section('goals, form and the ranking');
  // A game two hours old with three players in it, so goals can be recorded
  // against something the screen would also allow.
  // Created in the future and then moved back: registration closes at kickoff,
  // so a session that is already two hours old cannot be signed up for — but
  // goals only make sense on one that has been played.
  const goalSession = await call('POST', '/sessions', {
    token: organizer,
    body: { startsAt: new Date(Date.now() + 4 * 86_400_000).toISOString() },
  });
  const gsid = goalSession.body.session.id;
  for (const who of [alice, bob, carol]) {
    await call('POST', `/sessions/${gsid}/register`, { token: who.token });
  }
  sql(`UPDATE sessions SET starts_at = '${new Date(Date.now() - 2 * 3_600_000).toISOString()}'
        WHERE id = '${gsid}';`);

  const notMyGoals = await call('POST', `/sessions/${gsid}/goals`, {
    token: alice.token, body: { memberId: bob.id, goals: 9 },
  });
  check('A MEMBER CANNOT RECORD SOMEBODY ELSE\'S GOALS', notMyGoals.status === 403, notMyGoals.status);

  check('but can record their own',
    (await call('POST', `/sessions/${gsid}/goals`, { token: alice.token, body: { goals: 3 } })).status === 200);
  check('an organizer can record anybody\'s',
    (await call('POST', `/sessions/${gsid}/goals`, {
      token: organizer, body: { memberId: bob.id, goals: 1 },
    })).status === 200);
  check('an absurd tally is refused',
    (await call('POST', `/sessions/${gsid}/goals`, { token: alice.token, body: { goals: 99 } })).status === 400);
  check('and somebody not on the list is a 404',
    (await call('POST', `/sessions/${gsid}/goals`, {
      token: organizer, body: { memberId: 'mem_nobody', goals: 1 },
    })).status === 404);

  const withGoals = await call('GET', `/sessions/${gsid}`, { token: organizer });
  const aliceReg = withGoals.body.registrations.find((r) => r.memberId === alice.id);
  check('the registration carries the goals', aliceReg?.goals === 3, JSON.stringify(aliceReg));

  const scoredProfile = await call('GET', `/members/${alice.id}/profile`, { token: alice.token });
  check('and the profile totals them up', scoredProfile.body?.profile?.goals >= 3,
    scoredProfile.body?.profile?.goals);

  const form = await call('GET', '/members/form', { token: alice.token });
  check('form comes back for the whole roster in one call',
    Array.isArray(form.body?.form) && form.body.form.length > 0, form.body?.window);
  const aliceForm = form.body.form.find((f) => f.memberId === alice.id);
  check('each entry is exactly the window wide',
    aliceForm?.recent?.length === form.body.window, JSON.stringify(aliceForm)?.slice(0, 120));
  check('and every square is a state the UI knows',
    form.body.form.every((f) => f.recent.every((x) => ['in', 'missed', 'waitlist', 'none'].includes(x))));

  const goalBoard = await call('GET', '/members/leaderboard?board=goals&limit=5', { token: alice.token });
  check('the goals board ranks from one', goalBoard.body?.entries?.[0]?.rank === 1,
    JSON.stringify(goalBoard.body?.entries?.[0]?.rank));
  check('BIGGEST TALLY FIRST',
    goalBoard.body.entries.every((e, i) => i === 0 || goalBoard.body.entries[i - 1].goals >= e.goals),
    JSON.stringify(goalBoard.body.entries.map((e) => e.goals)));
  check('and nobody on zero is listed', goalBoard.body.entries.every((e) => e.goals > 0),
    JSON.stringify(goalBoard.body.entries.map((e) => e.goals)));

  const streakBoard = await call('GET', '/members/leaderboard?board=streak&limit=5', { token: alice.token });
  check('the streak board is ordered by the run',
    streakBoard.body.entries.every((e, i) => i === 0 ||
      streakBoard.body.entries[i - 1].streak.current >= e.streak.current),
    JSON.stringify(streakBoard.body.entries.map((e) => e.streak.current)));
  // Ranks have to keep counting across a page boundary, or the second page
  // starts at 1 again and the board says two people are winning.
  if (streakBoard.body.nextCursor) {
    const second = await call(
      'GET', `/members/leaderboard?board=streak&limit=5&cursor=${streakBoard.body.nextCursor}`,
      { token: alice.token });
    check('RANKS KEEP COUNTING ONTO THE NEXT PAGE', second.body?.entries?.[0]?.rank === 6,
      second.body?.entries?.[0]?.rank);
  }

  section('the long lists are paginated');
  // Past fixtures, newest first.
  const pastPage = await call('GET', '/sessions/past?limit=5', { token: organizer });
  check('past sessions come a page at a time', pastPage.body?.sessions?.length <= 5,
    pastPage.body?.sessions?.length);
  const allPast = await walk(organizer, '/sessions/past?limit=5', 'sessions');
  const pastIds = allPast.map((x) => x.id);
  check('NO FIXTURE IS SKIPPED OR REPEATED', new Set(pastIds).size === pastIds.length,
    `${pastIds.length} rows, ${new Set(pastIds).size} distinct`);
  check('and they stay newest-first across pages',
    allPast.every((x, i) => i === 0 || allPast[i - 1].startsAt >= x.startsAt),
    allPast.find((x, i) => i > 0 && allPast[i - 1].startsAt < x.startsAt)?.startsAt);
  check('every one of them has already happened or is finished',
    allPast.every((x) => x.startsAt < new Date().toISOString() || x.status !== 'scheduled'));
  check('an unreadable fixture cursor starts from the top',
    (await call('GET', '/sessions/past?cursor=zzz', { token: organizer })).body?.sessions?.[0]?.id
      === allPast[0]?.id);

  // Who owes what, biggest debt first — the order has to be the server's, or
  // paging would sort each page separately and the list would mean nothing.
  const owedPage = await call('GET', '/members/balances?limit=4', { token: alice.token });
  check('balances come a page at a time', owedPage.body?.balances?.length <= 4,
    owedPage.body?.balances?.length);
  const allOwed = await walk(alice.token, '/members/balances?limit=4', 'balances');
  const owedIds = allOwed.map((x) => x.member.id);
  check('no debtor is skipped or repeated', new Set(owedIds).size === owedIds.length,
    `${owedIds.length} rows, ${new Set(owedIds).size} distinct`);
  check('DEBTORS STAY IN ORDER ACROSS PAGE BOUNDARIES',
    allOwed.every((x, i) => i === 0 || allOwed[i - 1].outstanding >= x.outstanding),
    allOwed.find((x, i) => i > 0 && allOwed[i - 1].outstanding < x.outstanding)?.outstanding);
  const oneBigRead = await call('GET', '/members/balances?limit=100', { token: alice.token });
  check('and small pages agree with one big read',
    oneBigRead.body.balances.every((x, i) => allOwed[i]?.member.id === x.member.id),
    'the first 100 differ');

  section('the roster is paginated');
  const firstPage = await call('GET', '/members?limit=3', { token: organizer });
  check('a page is no bigger than asked for', firstPage.body?.members?.length <= 3,
    firstPage.body?.members?.length);
  check('and offers a cursor when there is more',
    typeof firstPage.body?.nextCursor === 'string' || firstPage.body?.nextCursor === null,
    firstPage.body?.nextCursor);

  const everyone = await allMembers(organizer);
  const counted = await call('GET', '/members/count', { token: organizer });
  check('walking the cursor reaches everybody', everyone.length === counted.body?.total,
    `${everyone.length} walked vs ${counted.body?.total} counted`);
  const ids = everyone.map((x) => x.id);
  check('NO MEMBER IS SKIPPED OR REPEATED ACROSS PAGES',
    new Set(ids).size === ids.length, `${ids.length} rows, ${new Set(ids).size} distinct`);
  const names = everyone.map((x) => x.name.toLowerCase());
  check('and the order is stable across page boundaries',
    names.every((n, i) => i === 0 || names[i - 1] <= n),
    names.find((n, i) => i > 0 && names[i - 1] > n));

  // Paging with a tiny limit must land on exactly the same people as one big
  // read — the case a naive OFFSET gets wrong when the table moves.
  const bigRead = await call('GET', '/members?limit=100', { token: organizer });
  check('a bigger page agrees with the small ones',
    bigRead.body.members.every((x, i) => everyone[i]?.id === x.id), 'first 100 differ');

  check('an unreadable cursor starts from the beginning',
    (await call('GET', '/members?cursor=not-base64', { token: organizer })).body?.members?.[0]?.id
      === everyone[0]?.id);
  check('the count needs no roster read', typeof counted.body?.total === 'number',
    counted.body);
  check('and a member can read the count too',
    (await call('GET', '/members/count', { token: alice.token })).status === 200);

  section('roster shows who has joined');
  const roster = { body: { members: await allMembers(organizer) } };
  const aliceRow = roster.body.members.find((x) => x.id === alice.id);
  check('claimed members are marked', !!aliceRow?.claimedAt, aliceRow);
  check('the nonce is never exposed to clients',
    !JSON.stringify(roster.body).includes('claim_nonce') && !/"nonce"/.test(JSON.stringify(roster.body)));

  section('revocation cuts off a lost device');
  const bobToken = bob.token;
  check('bob works before revocation',
    (await call('GET', '/auth/me', { token: bobToken })).status === 200);

  const selfRevoke = await call('DELETE', `/members/${organizerId}/claim`, { token: organizer });
  check('the organizer cannot revoke themselves', selfRevoke.status === 409, selfRevoke.body);

  const revoked = await call('DELETE', `/members/${bob.id}/claim`, { token: organizer });
  check('organizer revokes a member', revoked.status === 200, revoked.body);

  const afterRevoke = await call('GET', '/auth/me', { token: bobToken });
  check('the revoked token stops working immediately', afterRevoke.status === 401, afterRevoke.status);
  check('and says what to do', /new link/i.test(afterRevoke.body?.error?.message ?? ''),
    afterRevoke.body?.error?.message);

  const memberRevoke = await call('DELETE', `/members/${carol.id}/claim`, { token: alice.token });
  check('members cannot revoke each other', memberRevoke.status === 403, memberRevoke.body);

  // Bob needs a fresh invitation, and it must work.
  const bobAgain = await call('POST', `/members/${bob.id}/claim-link`, { token: organizer });
  const bobBack = await call('POST', '/auth/claim', { body: { nonce: nonceOf(bobAgain.body.url) } });
  check('a re-invited member gets back in', bobBack.status === 200, bobBack.body);
  bob.token = bobBack.body.token;

  section('group invite link');
  // Not "is it null?" — the local database persists between runs, so that only
  // held the first time. What must always be true is that the GET is an
  // organizer tool and that it reports whatever link is currently live.
  const beforeInvite = await call('GET', '/group-invite', { token: organizer });
  check('the current group link is readable', beforeInvite.status === 200 &&
    'invite' in beforeInvite.body, JSON.stringify(beforeInvite.body).slice(0, 120));

  const memberReads = await call('GET', '/group-invite', { token: alice.token });
  check('members cannot read the group link', memberReads.status === 403, memberReads.body);

  const memberTriesToMint = await call('POST', '/group-invite', { token: alice.token });
  check('members cannot mint the group link', memberTriesToMint.status === 403, memberTriesToMint.body);

  const groupLink = await call('POST', '/group-invite', { token: organizer });
  check('organizer creates the group link', groupLink.status === 200 && !!groupLink.body?.invite?.url,
    JSON.stringify(groupLink.body).slice(0, 120));
  check('it points at /join with the nonce in the fragment',
    /\/join#[A-Za-z0-9_-]{40,}$/.test(groupLink.body?.invite?.url ?? ''), groupLink.body?.invite?.url);
  const groupNonce = nonceOf(groupLink.body.invite.url);

  const afterCreate = await call('GET', '/group-invite', { token: organizer });
  check('and the GET now returns exactly that link',
    nonceOf(afterCreate.body?.invite?.url ?? '') === groupNonce, afterCreate.body?.invite?.url);

  // Somebody who has never signed in uses it.
  const dave = await call('POST', '/members', { token: organizer, body: { name: `Dave ${stamp}` } });
  const erin = await call('POST', '/members', { token: organizer, body: { name: `Erin ${stamp}` } });

  const joinRoster = await call('POST', '/auth/group/roster', { body: { nonce: groupNonce } });
  check('the roster needs no credentials', joinRoster.status === 200, roster.status);
  const offered = joinRoster.body.members.map((x) => x.name);
  check('unclaimed members are offered', offered.includes(`Dave ${stamp}`) && offered.includes(`Erin ${stamp}`),
    JSON.stringify(offered));
  check('already-claimed members are not offered', !offered.includes(alice.name), JSON.stringify(offered));
  check('ORGANIZERS ARE NEVER OFFERED', !offered.includes('Organizer'), JSON.stringify(offered));
  check('the roster leaks nothing but id and name',
    Object.keys(joinRoster.body.members[0] ?? {}).sort().join(',') === 'id,name',
    JSON.stringify(joinRoster.body.members[0]));

  const badNonce = await call('POST', '/auth/group/roster', { body: { nonce: 'q'.repeat(40) } });
  check('a wrong group nonce is refused', badNonce.status === 401, badNonce.body);

  const daveJoins = await call('POST', '/auth/group/claim', {
    body: { nonce: groupNonce, memberId: dave.body.member.id },
  });
  check('taking a name signs you in', daveJoins.status === 200 && !!daveJoins.body.token,
    JSON.stringify(daveJoins.body).slice(0, 120));
  check('as the right person', daveJoins.body?.identity?.name === `Dave ${stamp}`, daveJoins.body?.identity);

  const daveAgain = await call('POST', '/auth/group/claim', {
    body: { nonce: groupNonce, memberId: dave.body.member.id },
  });
  check('a taken name cannot be taken again', daveAgain.status === 409, daveAgain.body);

  const afterDave = await call('POST', '/auth/group/roster', { body: { nonce: groupNonce } });
  check('and drops off the list', !afterDave.body.members.some((x) => x.name === `Dave ${stamp}`),
    JSON.stringify(afterDave.body.members.map((x) => x.name)));

  // The whole point of the design: admin cannot be grabbed from the group link.
  const grabAdmin = await call('POST', '/auth/group/claim', {
    body: { nonce: groupNonce, memberId: organizerId },
  });
  check('AN ORGANIZER CANNOT BE CLAIMED THROUGH THE GROUP LINK', grabAdmin.status === 409, grabAdmin.body);

  const rotated = await call('POST', '/group-invite', { token: organizer });
  check('rotating produces a different link', nonceOf(rotated.body.invite.url) !== groupNonce);
  const staleGroup = await call('POST', '/auth/group/roster', { body: { nonce: groupNonce } });
  check('the old group link stops working', stale.status === 401, stale.body);
  const freshGroup = await call('POST', '/auth/group/roster', { body: { nonce: nonceOf(rotated.body.invite.url) } });
  check('the new one works', freshGroup.status === 200, freshGroup.status);
  check('it reports who is still to join', rotated.body.invite.unclaimed >= 1,
    String(rotated.body.invite.unclaimed));

  // Un-claiming puts a name back on the list, which is how a mis-tap is fixed.
  await call('DELETE', `/members/${dave.body.member.id}/claim`, { token: organizer });
  const reopened = await call('POST', '/auth/group/roster', { body: { nonce: nonceOf(rotated.body.invite.url) } });
  check('un-claiming puts the name back', reopened.body.members.some((x) => x.name === `Dave ${stamp}`),
    JSON.stringify(reopened.body.members.map((x) => x.name)));
  void erin;

  section('payment details');
  // There is one row for the whole group, and this section overwrites it and
  // then deletes it — against the same local database somebody has been
  // clicking around in all afternoon. Put back whatever was there.
  const detailsBefore = (await call('GET', '/payment-details', { token: organizer })).body?.details
    ?? null;

  const noDetails = await call('GET', '/payment-details', { token: alice.token });
  check('payment details are readable by any member', noDetails.status === 200, noDetails.status);
  check('and absent until an organizer sets them', 'details' in noDetails.body, noDetails.body);

  const memberWrite = await call('PUT', '/payment-details', {
    token: alice.token,
    body: { bankBin: '970436', bankName: 'Vietcombank', accountNumber: '0881000458086', accountName: 'HACKER' },
  });
  check('MEMBERS CANNOT REDIRECT THE GROUP\'S TRANSFERS', memberWrite.status === 403, memberWrite.status);

  const saved = await call('PUT', '/payment-details', {
    token: organizer,
    body: {
      bankBin: '970436', bankName: 'Vietcombank',
      accountNumber: '0881000458086', accountName: 'NGUYEN VAN A',
      note: 'Put your name in the transfer note',
    },
  });
  check('an organizer sets them', saved.status === 200, JSON.stringify(saved.body).slice(0, 140));

  const readBack = await call('GET', '/payment-details', { token: alice.token });
  check('every member can then read them', readBack.body?.details?.accountNumber === '0881000458086',
    JSON.stringify(readBack.body?.details));
  check('including who the account belongs to',
    readBack.body?.details?.accountName === 'NGUYEN VAN A', readBack.body?.details?.accountName);

  const anon = await call('GET', '/payment-details');
  check('but not without signing in', anon.status === 401, anon.status);

  const badBin = await call('PUT', '/payment-details', {
    token: organizer,
    body: { bankBin: '97', bankName: 'X', accountNumber: '0881000458086', accountName: 'A' },
  });
  check('a malformed bank code is refused', badBin.status === 400, badBin.body);
  const badAccount = await call('PUT', '/payment-details', {
    token: organizer,
    body: { bankBin: '970436', bankName: 'X', accountNumber: '08-81', accountName: 'A' },
  });
  check('an account number with punctuation is refused', badAccount.status === 400, badAccount.body);

  const memberClear = await call('DELETE', '/payment-details', { token: alice.token });
  check('members cannot remove them either', memberClear.status === 403, memberClear.status);
  check('the organizer can', (await call('DELETE', '/payment-details', { token: organizer })).status === 200);
  check('and they are gone',
    (await call('GET', '/payment-details', { token: alice.token })).body?.details === null);

  // Hand the group's real account back, so a test run is not a way to lose it.
  if (detailsBefore) {
    await call('PUT', '/payment-details', {
      token: organizer,
      body: {
        bankBin: detailsBefore.bankBin,
        bankName: detailsBefore.bankName,
        accountNumber: detailsBefore.accountNumber,
        accountName: detailsBefore.accountName,
        note: detailsBefore.note ?? null,
      },
    });
    const restored = await call('GET', '/payment-details', { token: organizer });
    check('AND THE REAL ONES ARE PUT BACK AFTERWARDS',
      restored.body?.details?.accountNumber === detailsBefore.accountNumber,
      JSON.stringify(restored.body?.details));
  }

  section('guests: friends without an account');
  // A pitch hired for four, so the arithmetic is visible.
  const guestSession = await call('POST', '/sessions', {
    token: organizer,
    body: { startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), maxPlayers: 4 },
  });
  const gs = guestSession.body.session.id;

  const solo = await call('POST', `/sessions/${gs}/register`, { token: alice.token });
  check('a member with no guests takes one spot', solo.body?.counts?.in === 1,
    JSON.stringify(solo.body?.counts));

  const party = await call('POST', `/sessions/${gs}/register`, {
    token: bob.token, body: { guests: 2 },
  });
  check('a party of three takes three', party.body?.counts?.in === 4,
    JSON.stringify(party.body?.counts));
  check('and the counts say how many were guests', party.body?.counts?.guests === 2,
    JSON.stringify(party.body?.counts));
  check('the registration records the party size', party.body?.registration?.guests === 2,
    JSON.stringify(party.body?.registration));

  // Full at four heads from two names — the row count would have said two.
  const overflow = await call('POST', `/sessions/${gs}/register`, { token: carol.token });
  check('GUESTS FILL THE PITCH, NOT JUST NAMES', overflow.body?.registration?.status === 'waitlist',
    JSON.stringify(overflow.body?.registration));

  const tooMany = await call('PATCH', `/sessions/${gs}/register`, {
    token: bob.token, body: { guests: 5 },
  });
  check('a party cannot grow past the cap', tooMany.status === 409, tooMany.body);
  check('and the refusal says how much room is left', /room for/.test(tooMany.body?.error?.message ?? ''),
    tooMany.body?.error?.message);

  const shrink = await call('PATCH', `/sessions/${gs}/register`, {
    token: bob.token, body: { guests: 0 },
  });
  check('bringing fewer frees the spots', shrink.body?.counts?.in <= 3,
    JSON.stringify(shrink.body?.counts));
  const afterShrink = await call('GET', `/sessions/${gs}`, { token: organizer });
  const carolNow = afterShrink.body.registrations.find((r) => r.memberId === carol.id);
  check('and promotes whoever was waiting', carolNow?.status === 'in', JSON.stringify(carolNow));

  const capGuests = await call('POST', `/sessions/${gs}/register`, {
    token: dave.body.member.id ? organizer : organizer, body: { guests: 9 },
  });
  check('an absurd party size is rejected outright', capGuests.status === 400, capGuests.status);

  // The money. Two heads for Bob, one each for Alice and Carol = 4 shares.
  await call('PATCH', `/sessions/${gs}/register`, { token: bob.token, body: { guests: 1 } });
  const settled = await call('POST', `/sessions/${gs}/settle`, {
    token: organizer, body: { totalCharge: 400_000 },
  });
  check('settling a session with guests works', settled.status === 200, settled.body);

  const bill = await call('GET', `/sessions/${gs}/payments`, { token: organizer });
  const byName = Object.fromEntries(bill.body.payments.map((p) => [p.memberId, p]));
  check('the guest-bringer is billed for two heads', byName[bob.id]?.amountDue === 200_000,
    JSON.stringify(byName[bob.id]));
  check('everybody else for one', byName[alice.id]?.amountDue === 100_000,
    JSON.stringify(byName[alice.id]));
  check('and the charge records what it was computed from', byName[bob.id]?.guests === 1,
    JSON.stringify(byName[bob.id]));

  const billed = bill.body.payments.reduce((sum, p) => sum + p.amountDue, 0);
  check('THE SHARES STILL SUM TO THE BILL EXACTLY', billed === 400_000, `${billed} of 400000`);

  // An awkward total is where a per-party rounding bug would show up.
  await call('POST', `/sessions/${gs}/settle`, { token: organizer, body: { totalCharge: 333_333 } });
  const odd = await call('GET', `/sessions/${gs}/payments`, { token: organizer });
  const oddTotal = odd.body.payments.reduce((sum, p) => sum + p.amountDue, 0);
  check('and on a total that does not divide evenly', oddTotal === 333_333, `${oddTotal} of 333333`);

  section('who actually turned up');
  // A pitch for 600.000 and three names on the list, so a missing head is
  // 200.000 of difference — visible, not a rounding artefact.
  const attSession = await call('POST', '/sessions', {
    token: organizer,
    body: { startsAt: new Date(Date.now() + 6 * 86_400_000).toISOString(), feePerPerson: 100_000 },
  });
  const as = attSession.body.session.id;
  for (const who of [alice, bob, carol]) {
    await call('POST', `/sessions/${as}/register`, { token: who.token });
  }

  // Nothing marked: must bill exactly as it did before attendance existed.
  await call('POST', `/sessions/${as}/settle`, { token: organizer, body: { totalCharge: 600_000 } });
  const unmarked = await call('GET', `/sessions/${as}/payments`, { token: organizer });
  check('an unchecked roster splits as it always did',
    unmarked.body.payments.every((p) => p.amountDue === 200_000),
    JSON.stringify(unmarked.body.payments.map((p) => p.amountDue)));

  const roster0 = await call('GET', `/sessions/${as}`, { token: organizer });
  check('and every registration starts unmarked, not absent',
    roster0.body.registrations.every((r) => r.attended === null),
    JSON.stringify(roster0.body.registrations.map((r) => r.attended)));

  // Carol did not come. Alice says so — and must not be allowed to.
  const notMyMark = await call('POST', `/sessions/${as}/attendance`, {
    token: alice.token, body: { memberId: carol.id, attended: false },
  });
  check('A MEMBER CANNOT MARK SOMEBODY ELSE ABSENT', notMyMark.status === 403, notMyMark.status);

  const selfMark = await call('POST', `/sessions/${as}/attendance`, {
    token: carol.token, body: { attended: false },
  });
  check('but can mark themselves', selfMark.status === 200, selfMark.body);
  check('and the head count drops', selfMark.body?.arrivedHeads === 2, selfMark.body?.arrivedHeads);

  const resettled = await call('POST', `/sessions/${as}/settle`, {
    token: organizer, body: { totalCharge: 600_000 },
  });
  check('re-settling works', resettled.status === 200, resettled.body);
  const afterNoShow = await call('GET', `/sessions/${as}/payments`, { token: organizer });
  const owed = Object.fromEntries(afterNoShow.body.payments.map((p) => [p.memberId, p.amountDue]));
  check('THE NO-SHOW IS NOT BILLED', owed[carol.id] === undefined, JSON.stringify(owed));
  check('and the two who played carry the whole pitch',
    owed[alice.id] === 300_000 && owed[bob.id] === 300_000, JSON.stringify(owed));
  const stillSums = afterNoShow.body.payments.reduce((s, p) => s + p.amountDue, 0);
  check('the bill is still exactly what the pitch cost', stillSums === 600_000, stillSums);

  // The organizer overrules, because the no-show will not open the app.
  const byOrganizer = await call('POST', `/sessions/${as}/attendance`, {
    token: organizer, body: { memberId: carol.id, attended: true },
  });
  check('an organizer can mark anybody', byOrganizer.status === 200, byOrganizer.body);
  check('and the head count comes back', byOrganizer.body?.arrivedHeads === 3,
    byOrganizer.body?.arrivedHeads);

  // Unmarking is a third state, not a synonym for absent.
  await call('POST', `/sessions/${as}/attendance`, {
    token: carol.token, body: { attended: null },
  });
  const cleared = await call('GET', `/sessions/${as}`, { token: organizer });
  const carolRow = cleared.body.registrations.find((r) => r.memberId === carol.id);
  check('clearing a mark returns it to unmarked, not absent', carolRow?.attended === null,
    JSON.stringify(carolRow));

  // Somebody not on the list at all.
  const stranger = await call('POST', `/sessions/${as}/attendance`, {
    token: organizer, body: { memberId: 'mem_nobody', attended: true },
  });
  check('marking somebody who never signed up is refused', stranger.status === 404, stranger.status);

  // Guests who did not come. A session of its own: settling marks a session
  // completed, and registration — including changing the party size — closes
  // with it.
  const guestArrival = await call('POST', '/sessions', {
    token: organizer,
    body: { startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
  });
  const ag = guestArrival.body.session.id;
  await call('POST', `/sessions/${ag}/register`, { token: alice.token });
  await call('POST', `/sessions/${ag}/register`, { token: bob.token, body: { guests: 2 } });

  const tooManyGuests = await call('POST', `/sessions/${ag}/attendance`, {
    token: bob.token, body: { guestsArrived: 4 },
  });
  check('cannot claim more guests arrived than were registered',
    tooManyGuests.status === 400, tooManyGuests.body);
  const oneCame = await call('POST', `/sessions/${ag}/attendance`, {
    token: bob.token, body: { guestsArrived: 1 },
  });
  check('bringing one of two friends is expressible', oneCame.status === 200, oneCame.body);
  check('and counts three heads, not four', oneCame.body?.arrivedHeads === 3,
    oneCame.body?.arrivedHeads);

  await call('POST', `/sessions/${ag}/settle`, { token: organizer, body: { totalCharge: 600_000 } });
  const guestBill = await call('GET', `/sessions/${ag}/payments`, { token: organizer });
  const guestOwed = Object.fromEntries(guestBill.body.payments.map((p) => [p.memberId, p]));
  check('the man who brought one friend pays for two',
    guestOwed[bob.id]?.amountDue === 400_000, JSON.stringify(guestOwed[bob.id]));
  check('and the friend who stayed home is not billed',
    guestOwed[alice.id]?.amountDue === 200_000, JSON.stringify(guestOwed[alice.id]));
  check('AND THE CHARGE RECORDS THE GUESTS THAT CAME, NOT THOSE PROMISED',
    guestOwed[bob.id]?.guests === 1, JSON.stringify(guestOwed[bob.id]));
  const guestSum = guestBill.body.payments.reduce((s, p) => s + p.amountDue, 0);
  check('and that bill sums exactly too', guestSum === 600_000, guestSum);

  section('self-add and the waiting room');
  const selfAdd = await call('POST', '/auth/group/self-add', {
    body: { nonce: nonceOf(rotated.body.invite.url), name: `Walkin ${stamp}` },
  });
  check('anyone with the group link can put a name forward', selfAdd.status === 201,
    JSON.stringify(selfAdd.body).slice(0, 150));
  check('and is signed in straight away', typeof selfAdd.body?.token === 'string');
  check('but NOT approved', selfAdd.body?.identity?.approved === false,
    JSON.stringify(selfAdd.body?.identity));

  const walkin = selfAdd.body.token;
  const walkinId = selfAdd.body.identity.memberId;

  // The gate is the server's, not the screen's.
  check('a pending member can find out they are waiting',
    (await call('GET', '/auth/me', { token: walkin })).status === 200);
  const pendingReads = await call('GET', '/sessions', { token: walkin });
  check('but cannot read the sessions', pendingReads.status === 403, pendingReads.status);
  const pendingRoster = await call('GET', '/members', { token: walkin });
  check('nor the roster', pendingRoster.status === 403, pendingRoster.status);
  const pendingProfile = await call('GET', `/members/${walkinId}/profile`, { token: walkin });
  check('nor anybody\'s profile', pendingProfile.status === 403, pendingProfile.status);

  const upcomingId = (await call('GET', '/sessions', { token: organizer })).body?.upcoming?.session?.id;
  const pendingJoin = await call('POST', `/sessions/${upcomingId}/register`, { token: walkin });
  check('AND CANNOT REGISTER FOR A MATCH', pendingJoin.status === 403, pendingJoin.status);

  // Nor do they show up anywhere as though they were in the group.
  const rosterDuring = await call('GET', '/members', { token: organizer });
  check('a pending member is not in the roster',
    !rosterDuring.body.members.some((x) => x.id === walkinId),
    rosterDuring.body.members.map((x) => x.name).join(','));

  const queue = await call('GET', '/members/pending', { token: organizer });
  check('but is in the organizer\'s queue', queue.body.members.some((x) => x.id === walkinId),
    JSON.stringify(queue.body.members?.map((x) => x.name)));
  const queueDenied = await call('GET', '/members/pending', { token: alice.token });
  check('which members cannot read', queueDenied.status === 403, queueDenied.status);

  const dupe = await call('POST', '/auth/group/self-add', {
    body: { nonce: nonceOf(rotated.body.invite.url), name: `Walkin ${stamp}` },
  });
  check('the same name cannot be added twice', dupe.status === 409, dupe.body);
  const noNonce = await call('POST', '/auth/group/self-add', {
    body: { nonce: 'q'.repeat(43), name: `Nobody ${stamp}` },
  });
  check('and not at all without the group link', noNonce.status === 401, noNonce.status);

  const notMine = await call('POST', `/members/${walkinId}/approve`, { token: alice.token });
  check('members cannot approve anyone', notMine.status === 403, notMine.status);

  const approved = await call('POST', `/members/${walkinId}/approve`, { token: organizer });
  check('the organizer lets them in', approved.status === 200 &&
    approved.body.member.approvedAt !== null, JSON.stringify(approved.body).slice(0, 120));
  check('approving twice is not an error',
    (await call('POST', `/members/${walkinId}/approve`, { token: organizer })).status === 200);

  // The token they were given at self-add must start working, without a new
  // one: approval is re-read per request, like membership and role.
  const nowIn = await call('GET', '/sessions', { token: walkin });
  check('THEIR EXISTING TOKEN NOW WORKS', nowIn.status === 200, nowIn.status);
  check('and /auth/me says approved',
    (await call('GET', '/auth/me', { token: walkin })).body?.identity?.approved === true);
  const rosterAfter = await allMembers(organizer);
  check('they are in the roster now', rosterAfter.some((x) => x.id === walkinId));
  check('and out of the queue',
    !(await call('GET', '/members/pending', { token: organizer })).body.members
      .some((x) => x.id === walkinId));

  // Turning somebody away frees the name for the person it belongs to.
  const turnAway = await call('POST', '/auth/group/self-add', {
    body: { nonce: nonceOf(rotated.body.invite.url), name: `Reject ${stamp}` },
  });
  const rejectId = turnAway.body.identity.memberId;
  const rejected = await call('DELETE', `/members/${rejectId}/approve`, { token: organizer });
  check('the organizer can turn somebody away', rejected.status === 200, rejected.body);
  const afterReject = await call('GET', '/auth/me', { token: turnAway.body.token });
  check('their token stops working entirely', afterReject.status === 401, afterReject.status);
  const nameFreed = await call('POST', '/auth/group/self-add', {
    body: { nonce: nonceOf(rotated.body.invite.url), name: `Reject ${stamp}` },
  });
  check('and the name is free again', nameFreed.status === 201, nameFreed.status);
  await call('DELETE', `/members/${nameFreed.body.identity.memberId}/approve`, { token: organizer });

  const rejectApproved = await call('DELETE', `/members/${walkinId}/approve`, { token: organizer });
  check('an approved member cannot be turned away this way', rejectApproved.status === 409,
    rejectApproved.status);

  section('profiles, streaks and pictures');
  const aliceProfile = await call('GET', `/members/${alice.id}/profile`, { token: alice.token });
  check('a member can read their own profile', aliceProfile.status === 200, aliceProfile.body);
  check('it reports a streak', typeof aliceProfile.body?.profile?.streak?.current === 'number',
    JSON.stringify(aliceProfile.body?.profile?.streak));
  check('it never leaks the R2 key',
    !JSON.stringify(aliceProfile.body).includes('avatar_key') &&
      !JSON.stringify(aliceProfile.body).includes('avatars/'),
    JSON.stringify(aliceProfile.body).slice(0, 200));

  // Anyone signed in can see anyone's run — a streak is a bragging right, and
  // these people already see each other on every session screen.
  const peerProfile = await call('GET', `/members/${organizerId}/profile`, { token: alice.token });
  check('and can read a team-mate\'s', peerProfile.status === 200, peerProfile.status);
  const anonProfile = await call('GET', `/members/${alice.id}/profile`);
  check('but not without signing in', anonProfile.status === 401, anonProfile.status);
  const ghostProfile = await call('GET', '/members/mem_nope/profile', { token: alice.token });
  check('an unknown member is a 404', ghostProfile.status === 404, ghostProfile.status);

  const noPicture = await call('GET', `/members/${alice.id}/avatar`, { token: alice.token });
  check('no picture yet', noPicture.status === 404, noPicture.status);
  check('and the profile says so', aliceProfile.body.profile.member.avatarUpdatedAt === null,
    aliceProfile.body.profile.member.avatarUpdatedAt);

  // A one-pixel PNG is a real image as far as the endpoint is concerned.
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const avatarUpload = await call('PUT', '/members/me/avatar', {
    token: alice.token,
    raw: onePixelPng,
    contentType: 'image/png',
  });
  check('uploading a picture works', avatarUpload.status === 200, JSON.stringify(avatarUpload.body).slice(0, 150));
  check('and stamps a cache token', typeof avatarUpload.body?.member?.avatarUpdatedAt === 'string',
    avatarUpload.body?.member?.avatarUpdatedAt);

  const fetched = await call('GET', `/members/${alice.id}/avatar`, { token: alice.token });
  check('the picture reads back', fetched.status === 200, fetched.status);
  check('as an image', (fetched.headers.get('content-type') ?? '').startsWith('image/'),
    fetched.headers.get('content-type'));
  check('and is not cached by shared proxies',
    (fetched.headers.get('cache-control') ?? '').includes('private'),
    fetched.headers.get('cache-control'));

  const wrongType = await call('PUT', '/members/me/avatar', {
    token: alice.token, raw: Buffer.from('not an image'), contentType: 'text/plain',
  });
  check('a non-image is refused', wrongType.status === 400, wrongType.body);

  const tooBig = await call('PUT', '/members/me/avatar', {
    token: alice.token, raw: Buffer.alloc(300_000, 1), contentType: 'image/png',
  });
  check('an oversized picture is refused', tooBig.status === 413, tooBig.status);

  // Registrations carry the token so a session list can draw faces in one call.
  const aliceAvatarRow = (await allMembers(organizer)).find((x) => x.id === alice.id);
  check('the roster carries the cache token',
    typeof aliceAvatarRow?.avatarUpdatedAt === 'string', aliceAvatarRow);

  const dropped = await call('DELETE', '/members/me/avatar', { token: alice.token });
  check('removing a picture works', dropped.status === 200 &&
    dropped.body.member.avatarUpdatedAt === null, JSON.stringify(dropped.body).slice(0, 120));
  const goneNow = await call('GET', `/members/${alice.id}/avatar`, { token: alice.token });
  check('and it is really gone', goneNow.status === 404, goneNow.status);

  section('streaks come from real attendance');
  // Joined before any of the seeded games, so nothing is filtered out for
  // pre-dating them.
  const runner = await addAndLogIn(organizer, `Runner ${stamp}`);

  // Oldest first: played, played, cancelled, missed entirely, played, played.
  seedPastSessions(runner.id, ['in', 'in', 'cancelled', 'absent', 'in', 'in']);
  // Joined just before the seeded window, so those six games — and only those
  // six — are the history this member is judged on.
  sql(`UPDATE members SET created_at = '${seedPastSessions.windowStart}' WHERE id = '${runner.id}';`);
  const streaked = await call('GET', `/members/${runner.id}/profile`, { token: runner.token });
  const st = streaked.body?.profile?.streak;
  check('a live run counts back from the newest game', st?.current === 2, JSON.stringify(st));
  check('a session with no registration row breaks it', st?.best === 2, JSON.stringify(st));
  check('a cancelled session is not a miss', st?.played === 4, JSON.stringify(st));
  check('and is not counted in the total either', st?.total === 5, JSON.stringify(st));

  // Signing up is not the same as turning up. Before attendance existed this
  // member would have had a run of four, because the sign-up sheet said so.
  const ghost = await addAndLogIn(organizer, `Ghost ${stamp}`);
  seedPastSessions(ghost.id, ['in', 'in', 'noshow', 'in']);
  sql(`UPDATE members SET created_at = '${seedPastSessions.windowStart}' WHERE id = '${ghost.id}';`);
  const ghostSt = (await call('GET', `/members/${ghost.id}/profile`, { token: ghost.token }))
    .body?.profile?.streak;
  check('A REGISTERED NO-SHOW BREAKS THE STREAK', ghostSt?.current === 1, JSON.stringify(ghostSt));
  check('and does not count as a game played', ghostSt?.played === 3, JSON.stringify(ghostSt));
  check('but still counts in the total, unlike a cancellation', ghostSt?.total === 4,
    JSON.stringify(ghostSt));

  // Somebody who joined after those games must not inherit their misses.
  const rookie = await addAndLogIn(organizer, `Rookie ${stamp}`);
  const rookieProfile = await call('GET', `/members/${rookie.id}/profile`, { token: rookie.token });
  check('games from before you joined do not count against you',
    rookieProfile.body?.profile?.streak?.total === 0,
    JSON.stringify(rookieProfile.body?.profile?.streak));

  // Hand the world back as it was found: these fabricated games sit in the
  // most recent slice of history, which the cron section reads.
  sql(`DELETE FROM sessions WHERE id LIKE 'ses_streak_%';`);

  section('realtime plumbing');
  const ticket = await call('POST', '/realtime/ticket', { token: alice.token });
  check('member gets a stream ticket', ticket.status === 200 && !!ticket.body.ticket, ticket.body);

  const noTicket = await fetch(`${BASE}/realtime/stream?channels=session:${sessionId}`);
  check('stream without a ticket is rejected', noTicket.status === 401, noTicket.status);

  const badChannel = await fetch(
    `${BASE}/realtime/stream?channels=${encodeURIComponent('evil*')}&ticket=${ticket.body.ticket}`,
  );
  check('arbitrary channels are rejected', badChannel.status === 400, badChannel.status);

  section('cron');
  const cron = await fetch(`${BASE}/cdn-cgi/local/scheduled`);
  check('scheduled handler runs', cron.status === 200, cron.status);
  await new Promise((r) => setTimeout(r, 500));
  const listed = await call('GET', '/sessions', { token: organizer });
  check('cron leaves an upcoming session scheduled', !!listed.body.upcoming, listed.body.upcoming);
  // Read the session itself rather than hunting for it in `recent`. That list
  // is windowed, and the dev database accumulates across runs — so a passing
  // assertion here was really asserting "the database is still small".
  const completedOne = await call('GET', `/sessions/${past.body.session.id}`, { token: organizer });
  check('past session was completed', completedOne.body?.session?.status === 'completed',
    completedOne.body?.session?.status);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFailures:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
};

run().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
