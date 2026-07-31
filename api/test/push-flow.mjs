/**
 * End-to-end push test against a running `wrangler dev`.
 *
 *   npm run dev -w @futsal/api        # terminal 1 (with VAPID keys in .dev.vars)
 *   npm run test:push:flow -w @futsal/api
 *
 * Stands up a local HTTP server that impersonates a push service, registers a
 * subscription pointing at it with a *real* generated P-256 keypair, and then
 * decrypts what the Worker sends back to the original JSON. That proves the
 * whole path — subscription storage, recipient selection, VAPID headers, and
 * RFC 8291 encryption with ephemeral keys — not just the fixed RFC vector.
 *
 * It also checks the parts that are easy to get wrong and invisible when they
 * are: that the hourly cron is idempotent, and that a dead endpoint is cleaned
 * up rather than retried forever.
 */
import { createServer } from 'node:http';
import { webcrypto as crypto } from 'node:crypto';

const BASE = process.env.API_URL ?? 'http://localhost:8787';
const INVITE = process.env.GROUP_INVITE_CODE ?? 'futsal-dev';
const PUSH_PORT = Number(process.env.PUSH_PORT ?? 9987);

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `\n         ${detail}`}`);
};
const section = (n) => console.log(`\n${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64u = {
  encode: (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
  decode: (s) => new Uint8Array(Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/'), 'base64')),
};

/* ------------------------------------------------- fake push service ----- */

const received = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // /gone/* always reports the subscription as expired.
    if (req.url.startsWith('/gone')) {
      res.writeHead(410).end();
      received.push({ url: req.url, gone: true });
      return;
    }
    received.push({
      url: req.url,
      headers: req.headers,
      body: new Uint8Array(Buffer.concat(chunks)),
    });
    res.writeHead(201).end();
  });
});
await new Promise((r) => server.listen(PUSH_PORT, r));

/* ------------------------------------------------- subscriber keys ------- */

const uaPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaPair.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));

const hmac = async (key, data) => {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
};
const hkdf = async (salt, ikm, info, len) => {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])]))).slice(0, len);
};

/** The receiver half of RFC 8291 — what a browser does internally. */
async function decryptPush(body) {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const asPublic = body.slice(21, 21 + idLen);
  const ciphertext = body.slice(21 + idLen);

  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPair.privateKey, 256),
  );

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info'), Buffer.from([0]), Buffer.from(uaPublic), Buffer.from(asPublic),
  ]);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, ciphertext),
  );
  // Strip the 0x02 record delimiter.
  return new TextDecoder().decode(plain.slice(0, plain.length - 1));
}

/* ------------------------------------------------- api helpers ----------- */

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function signIn(memberId) {
  const gate = await call('POST', '/auth/gate', { body: { code: INVITE } });
  const join = await call('POST', '/auth/join', { body: { gateToken: gate.body.gateToken, memberId } });
  return join.body.token;
}

const runCron = () => fetch(`${BASE}/cdn-cgi/local/scheduled`).then((r) => r.status);

/* ------------------------------------------------- the test -------------- */

try {
  const stamp = Date.now();

  section('setup');
  const health = await call('GET', '/health');
  check('worker is up', health.status === 200);

  const gate = await call('POST', '/auth/gate', { body: { code: INVITE } });
  const organizer = gate.body.members.find((m) => m.isOrganizer);
  const orgToken = await signIn(organizer.id);
  check('signed in as organizer', !!orgToken);

  const status = await call('GET', '/push/status', { token: orgToken });
  check('push is configured on the server', status.body?.enabled === true,
    'set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in api/.dev.vars');
  if (!status.body?.enabled) throw new Error('push disabled — cannot continue');
  check('status exposes the application server key', typeof status.body.publicKey === 'string');

  section('subscribing a device');
  const endpoint = `http://localhost:${PUSH_PORT}/push/${stamp}`;
  const sub = await call('POST', '/push/subscribe', {
    token: orgToken,
    body: { endpoint, keys: { p256dh: b64u.encode(uaPublic), auth: b64u.encode(authSecret) } },
  });
  check('subscription accepted', sub.status === 200, JSON.stringify(sub.body));

  const afterSub = await call('GET', '/push/status', { token: orgToken });
  check('device is counted', afterSub.body.devices >= 1, String(afterSub.body.devices));

  // Re-subscribing the same endpoint must not create a second row.
  await call('POST', '/push/subscribe', {
    token: orgToken,
    body: { endpoint, keys: { p256dh: b64u.encode(uaPublic), auth: b64u.encode(authSecret) } },
  });
  const afterDup = await call('GET', '/push/status', { token: orgToken });
  check('re-subscribing does not duplicate the device',
    afterDup.body.devices === afterSub.body.devices, String(afterDup.body.devices));

  section('delivery + encryption round trip');
  received.length = 0;
  const test = await call('POST', '/push/test', { token: orgToken });
  check('test reports one send', test.body?.sent === 1, JSON.stringify(test.body));
  await sleep(300);
  check('push service received a request', received.length === 1, String(received.length));

  const request = received[0];
  check('content encoding is aes128gcm', request.headers['content-encoding'] === 'aes128gcm');
  check('VAPID authorization present', (request.headers.authorization ?? '').startsWith('vapid t='));
  check('TTL header set', Number(request.headers.ttl) > 0, request.headers.ttl);

  const decrypted = await decryptPush(request.body);
  const payload = JSON.parse(decrypted);
  check('payload decrypts with the subscriber key', typeof payload.title === 'string', decrypted);
  check('payload carries a title and body', !!payload.title && !!payload.body, decrypted);
  check('payload carries a deep link', typeof payload.url === 'string', decrypted);

  section('match reminder');
  // A session 3.5h out falls inside the [3h, 4h) window the hourly cron scans.
  const soon = new Date(Date.now() + 3.5 * 3600_000).toISOString();
  const session = await call('POST', '/sessions', { token: orgToken, body: { startsAt: soon } });
  check('created a session inside the reminder window', session.status === 201, JSON.stringify(session.body));
  const sessionId = session.body.session.id;
  await call('POST', `/sessions/${sessionId}/register`, { token: orgToken });

  received.length = 0;
  await runCron();
  await sleep(900);
  check('reminder was sent', received.length === 1, String(received.length));
  if (received.length === 1) {
    const reminder = JSON.parse(await decryptPush(received[0].body));
    check('reminder mentions the kickoff time', /\d{2}:\d{2}/.test(reminder.title), reminder.title);
    check('reminder links to the session', reminder.url === `/session/${sessionId}`, reminder.url);
  }

  section('idempotency');
  received.length = 0;
  await runCron();
  await sleep(900);
  check('a second cron run sends nothing', received.length === 0, `${received.length} duplicate(s)`);

  section('unpaid nudge');
  // Register first, then move the session into the past and settle it — you
  // cannot register for a session that has already kicked off.
  const past = await call('POST', '/sessions', {
    token: orgToken,
    body: { startsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
  });
  const pastId = past.body.session.id;
  await call('POST', `/sessions/${pastId}/register`, { token: orgToken });
  await call('PATCH', `/sessions/${pastId}`, {
    token: orgToken,
    body: { startsAt: new Date(Date.now() - 48 * 3600_000).toISOString() },
  });
  const settled = await call('POST', `/sessions/${pastId}/settle`, {
    token: orgToken, body: { totalCharge: 120_000 },
  });
  check('settled a session from two days ago', settled.status === 200, JSON.stringify(settled.body).slice(0, 120));

  received.length = 0;
  await runCron();
  await sleep(900);
  check('unpaid nudge was sent', received.length === 1, String(received.length));
  if (received.length === 1) {
    const nudge = JSON.parse(await decryptPush(received[0].body));
    check('nudge names the amount owed', nudge.body.includes('120.000d'), nudge.body);
    check('nudge links to payments', nudge.url === `/payments/${pastId}`, nudge.url);
  }

  received.length = 0;
  await runCron();
  await sleep(900);
  check('the nudge does not repeat within the same week', received.length === 0, String(received.length));

  section('preferences');
  await call('PATCH', '/push/preferences', { token: orgToken, body: { notifySession: false } });
  const prefs = await call('GET', '/push/status', { token: orgToken });
  check('preference persisted', prefs.body.notifySession === false, JSON.stringify(prefs.body));

  section('dead endpoints are cleaned up');
  const deadEndpoint = `http://localhost:${PUSH_PORT}/gone/${stamp}`;
  await call('POST', '/push/subscribe', {
    token: orgToken,
    body: { endpoint: deadEndpoint, keys: { p256dh: b64u.encode(uaPublic), auth: b64u.encode(authSecret) } },
  });
  const before = (await call('GET', '/push/status', { token: orgToken })).body.devices;
  const cleanup = await call('POST', '/push/test', { token: orgToken });
  check('410 endpoint reported as removed', cleanup.body?.removed === 1, JSON.stringify(cleanup.body));
  const after = (await call('GET', '/push/status', { token: orgToken })).body.devices;
  check('dead subscription was deleted', after === before - 1, `${before} -> ${after}`);

  section('unsubscribe');
  await call('POST', '/push/unsubscribe', { token: orgToken, body: { endpoint } });
  const gone = await call('GET', '/push/status', { token: orgToken });
  check('device removed', gone.body.devices === 0, String(gone.body.devices));
} catch (error) {
  console.error('\nCrashed:', error);
  failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
server.close();
process.exit(failed === 0 ? 0 : 1);
