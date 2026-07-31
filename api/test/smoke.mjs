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

const BASE = process.env.API_URL ?? 'http://localhost:8787';
const INVITE_CODE = process.env.GROUP_INVITE_CODE ?? 'futsal-dev';

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

/** Creates a member (as organizer) and signs them in, returning their token. */
async function addAndLogIn(organizerToken, name) {
  const created = await call('POST', '/members', { token: organizerToken, body: { name } });
  if (created.status !== 201) throw new Error(`could not create ${name}: ${JSON.stringify(created.body)}`);

  const gate = await call('POST', '/auth/gate', { body: { code: INVITE_CODE } });
  const join = await call('POST', '/auth/join', {
    body: { gateToken: gate.body.gateToken, memberId: created.body.member.id },
  });
  return { id: created.body.member.id, name, token: join.body.token };
}

const run = async () => {
  const stamp = Date.now();

  section('health + invite gate');
  const health = await call('GET', '/health');
  check('health responds', health.status === 200 && health.body.ok === true, health.body);

  const badGate = await call('POST', '/auth/gate', { body: { code: 'definitely-wrong' } });
  check('wrong invite code is rejected', badGate.status === 401, badGate.body);

  const gate = await call('POST', '/auth/gate', { body: { code: INVITE_CODE } });
  check('correct invite code opens the gate', gate.status === 200 && !!gate.body.gateToken);
  check('gate reveals the member list', Array.isArray(gate.body.members) && gate.body.members.length > 0);

  const noAuth = await call('GET', '/sessions');
  check('protected routes need a token', noAuth.status === 401, noAuth.body);

  section('identity');
  const organizerMember = gate.body.members.find((m) => m.isOrganizer);
  check('seed organizer exists', !!organizerMember, gate.body.members);

  const badJoin = await call('POST', '/auth/join', {
    body: { gateToken: 'not-a-real-token', memberId: organizerMember.id },
  });
  check('join requires a valid gate token', badJoin.status === 401, badJoin.body);

  const join = await call('POST', '/auth/join', {
    body: { gateToken: gate.body.gateToken, memberId: organizerMember.id },
  });
  check('organizer can join', join.status === 200 && !!join.body.token, join.body);
  const organizer = join.body.token;

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
