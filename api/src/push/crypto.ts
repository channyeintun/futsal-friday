import { b64urlDecode, b64urlEncode, concatBytes, utf8 } from '../lib/base64.js';

/**
 * Web Push message encryption — RFC 8291 (aes128gcm), plus RFC 8292 VAPID.
 *
 * Implemented directly on WebCrypto rather than pulled from npm: the usual
 * `web-push` package is Node-only, and this is about 150 lines of well-specified
 * key derivation that can be proved correct. `test/push-vectors.mjs` runs the
 * worked example from RFC 8291 Appendix A through `encryptPayload` and compares
 * the full body byte for byte, so a mistake here fails the build rather than
 * silently producing undecryptable notifications.
 */

/** Advertised record size. One notification always fits in a single record. */
const RECORD_SIZE = 4096;

export interface PushKeys {
  /** Subscriber's P-256 public key (`keys.p256dh`), base64url. */
  p256dh: string;
  /** Subscriber's auth secret (`keys.auth`), base64url, 16 bytes. */
  auth: string;
}

/* ------------------------------------------------------------------- HKDF */

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data as BufferSource));
}

/**
 * HKDF with a single-block expand, which is all Web Push ever needs — every
 * output here is 32 bytes or fewer.
 */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, concatBytes(info, Uint8Array.of(0x01)));
  return okm.slice(0, length);
}

/* -------------------------------------------------------------- key import */

/** Import an uncompressed P-256 point (65 bytes, 0x04 || X || Y) for ECDH. */
function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

/**
 * Import a P-256 private key from its raw scalar.
 *
 * WebCrypto cannot import a bare scalar, so it is rebuilt as a JWK alongside
 * the matching public point — which the caller already has.
 */
function importPrivateKey(
  privateScalar: Uint8Array,
  publicPoint: Uint8Array,
  usage: 'ECDH' | 'ECDSA',
): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: b64urlEncode(privateScalar),
    x: b64urlEncode(publicPoint.slice(1, 33)),
    y: b64urlEncode(publicPoint.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: usage, namedCurve: 'P-256' },
    false,
    usage === 'ECDH' ? ['deriveBits'] : ['sign'],
  );
}

/* --------------------------------------------------------------- encryption */

export interface EncryptedPayload {
  /** The complete `aes128gcm` body, ready to POST. */
  body: Uint8Array;
}

/**
 * Encrypt a payload for one subscription.
 *
 * `senderKeys` exists for the RFC test vector; production passes nothing and a
 * fresh ephemeral keypair is generated per message, as the spec requires.
 */
export async function encryptPayload(
  payload: string,
  keys: PushKeys,
  senderKeys?: { publicKey: Uint8Array; privateKey: Uint8Array; salt: Uint8Array },
): Promise<EncryptedPayload> {
  const uaPublic = b64urlDecode(keys.p256dh);
  const authSecret = b64urlDecode(keys.auth);

  let asPublic: Uint8Array;
  let asPrivateKey: CryptoKey;
  let salt: Uint8Array;

  if (senderKeys) {
    asPublic = senderKeys.publicKey;
    asPrivateKey = await importPrivateKey(senderKeys.privateKey, senderKeys.publicKey, 'ECDH');
    salt = senderKeys.salt;
  } else {
    const pair = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    )) as CryptoKeyPair;
    asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
    asPrivateKey = pair.privateKey;
    salt = crypto.getRandomValues(new Uint8Array(16));
  }

  const uaPublicKey = await importPublicKey(uaPublic);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // The runtime property is `public`, per the WebCrypto spec. Cloudflare's
      // generated types call it `$public` because `public` is reserved in their
      // IDL — a typings artifact only. Do not "fix" this to `$public`: it would
      // typecheck and then silently derive nothing at runtime.
      { name: 'ECDH', public: uaPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      asPrivateKey,
      256,
    ),
  );

  // RFC 8291 §3.4. Note the order: the *user agent* key comes first.
  const keyInfo = concatBytes(
    utf8('WebPush: info'),
    Uint8Array.of(0x00),
    uaPublic,
    asPublic,
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ]);
  // 0x02 is the last-record delimiter (RFC 8188 §2); a padding-only tail is not
  // used because every notification here fits one record.
  const plaintext = concatBytes(utf8(payload), Uint8Array.of(0x02));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 },
      aesKey,
      plaintext as BufferSource,
    ),
  );

  // Header: salt(16) || record size(4, big-endian) || key id length(1) || key id
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE, false);

  return {
    body: concatBytes(
      salt,
      recordSize,
      Uint8Array.of(asPublic.length),
      asPublic,
      ciphertext,
    ),
  };
}

/* -------------------------------------------------------------------- VAPID */

export interface VapidKeys {
  /** base64url uncompressed P-256 point. Public — shipped to the browser. */
  publicKey: string;
  /** base64url raw scalar. Secret. */
  privateKey: string;
  /** `mailto:` or `https:` contact, per RFC 8292. */
  subject: string;
}

/**
 * Build the `Authorization: vapid t=..., k=...` header proving to the push
 * service which application server is sending.
 */
export async function vapidAuthorization(
  endpoint: string,
  vapid: VapidKeys,
  now: number = Date.now(),
): Promise<string> {
  const audience = new URL(endpoint).origin;

  const header = b64urlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    utf8(
      JSON.stringify({
        aud: audience,
        // Spec allows 24h; 12h leaves room for clock skew at both ends.
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;

  const publicKey = b64urlDecode(vapid.publicKey);
  const privateKey = await importPrivateKey(
    b64urlDecode(vapid.privateKey),
    publicKey,
    'ECDSA',
  );

  // WebCrypto emits the raw r||s form that JWS wants — no DER unwrapping.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      utf8(signingInput) as BufferSource,
    ),
  );

  return `vapid t=${signingInput}.${b64urlEncode(signature)}, k=${vapid.publicKey}`;
}

/** Generate a VAPID keypair. Used by `npm run push:keys`. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;

  return {
    publicKey: b64urlEncode(publicKey),
    privateKey: jwk.d!,
  };
}
