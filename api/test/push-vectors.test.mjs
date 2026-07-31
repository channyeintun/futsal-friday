/**
 * RFC 8291 Appendix A conformance test.
 *
 * Runs the specification's own worked example through `encryptPayload` with the
 * example's fixed sender key and salt, and compares the entire aes128gcm body
 * against the published result. If the key derivation is wrong by a single
 * byte, this fails — which beats discovering it as notifications that silently
 * never arrive.
 *
 *   node --experimental-strip-types api/test/push-vectors.test.mjs
 */
import { encryptPayload, generateVapidKeys, vapidAuthorization } from '../src/push/crypto.ts';
import { b64urlDecode, b64urlEncode } from '../src/lib/base64.ts';

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failed++;
    if (detail) console.log(`         ${detail}`);
  }
};

// --- RFC 8291 Appendix A ----------------------------------------------------
const PLAINTEXT = 'When I grow up, I want to be a watermelon';
const AUTH_SECRET = 'BTBZMqHH6r4Tts7J_aSIgg';
const UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AS_PUBLIC = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const AS_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const SALT = 'DGv6ra1nlYgDCS1FRnbzlw';
const EXPECTED_BODY =
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
  'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
  'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

console.log('\nRFC 8291 Appendix A (aes128gcm)');

const { body } = await encryptPayload(
  PLAINTEXT,
  { p256dh: UA_PUBLIC, auth: AUTH_SECRET },
  {
    publicKey: b64urlDecode(AS_PUBLIC),
    privateKey: b64urlDecode(AS_PRIVATE),
    salt: b64urlDecode(SALT),
  },
);

const actual = b64urlEncode(body);
check('encrypted body matches the RFC vector byte for byte', actual === EXPECTED_BODY,
  `got  ${actual}\n         want ${EXPECTED_BODY}`);
check('body length is salt+rs+idlen+key+ciphertext', body.length === 16 + 4 + 1 + 65 + 58, String(body.length));
check('header carries the sender public key', b64urlEncode(body.slice(21, 86)) === AS_PUBLIC);
check('record size is 4096', new DataView(body.buffer, body.byteOffset).getUint32(16, false) === 4096);

// --- non-determinism --------------------------------------------------------
console.log('\nephemeral keys');
const a = await encryptPayload('hello', { p256dh: UA_PUBLIC, auth: AUTH_SECRET });
const b = await encryptPayload('hello', { p256dh: UA_PUBLIC, auth: AUTH_SECRET });
check('a fresh keypair and salt are used per message',
  b64urlEncode(a.body) !== b64urlEncode(b.body));
check('both still have the right shape', a.body.length === b.body.length && a.body.length === 16 + 4 + 1 + 65 + 22);

// --- VAPID ------------------------------------------------------------------
console.log('\nVAPID (RFC 8292)');
const keys = await generateVapidKeys();
check('public key is an uncompressed P-256 point',
  b64urlDecode(keys.publicKey).length === 65 && b64urlDecode(keys.publicKey)[0] === 0x04);
check('private key is a 32-byte scalar', b64urlDecode(keys.privateKey).length === 32);

const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123', {
  ...keys,
  subject: 'mailto:organizer@example.com',
});

check('header uses the vapid scheme', header.startsWith('vapid t='));
check('header advertises the public key', header.includes(`k=${keys.publicKey}`));

const jwt = header.slice('vapid t='.length).split(',')[0];
const [h, c, s] = jwt.split('.');
const decodedHeader = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));

check('alg is ES256', decodedHeader.alg === 'ES256', JSON.stringify(decodedHeader));
check('aud is the push service origin, not the full endpoint',
  claims.aud === 'https://fcm.googleapis.com', claims.aud);
check('sub is carried through', claims.sub === 'mailto:organizer@example.com');
check('exp is in the future and within the 24h the spec allows',
  claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 86400, String(claims.exp));
check('signature is raw r||s, not DER', b64urlDecode(s).length === 64, String(b64urlDecode(s).length));

// The signature must actually verify under the advertised public key.
const verifyKey = await crypto.subtle.importKey(
  'raw',
  b64urlDecode(keys.publicKey),
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['verify'],
);
const valid = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' },
  verifyKey,
  b64urlDecode(s),
  new TextEncoder().encode(`${h}.${c}`),
);
check('signature verifies against the advertised public key', valid);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
