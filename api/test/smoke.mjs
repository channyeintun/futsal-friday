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

  const balancesDenied = await call('GET', '/members/balances', { token: alice.token });
  check('non-organizers cannot read balances', balancesDenied.status === 403, balancesDenied.body);

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

  const balances = await call('GET', '/members/balances', { token: organizer });
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

  section('roster shows who has joined');
  const roster = await call('GET', '/members', { token: organizer });
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
  check('past session was completed',
    listed.body.recent.some((s) => s.id === past.body.session.id && s.status === 'completed'),
    listed.body.recent.map((s) => [s.id, s.status]));

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
