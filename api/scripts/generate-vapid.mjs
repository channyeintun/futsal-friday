/**
 * Generate a VAPID keypair for Web Push.
 *
 *   npm run push:keys -w @futsal/api
 *
 * The public key is not secret — it is compiled into the frontend so browsers
 * can create subscriptions. The private key is, and belongs in
 * `wrangler secret put VAPID_PRIVATE_KEY`.
 *
 * Rotating these invalidates every existing subscription, so do it once.
 */
import { webcrypto } from 'node:crypto';

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);

const publicKey = b64url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)));
const { d: privateKey } = await webcrypto.subtle.exportKey('jwk', pair.privateKey);

console.log(`
VAPID keypair generated.

  Public key  (not secret — goes in web/.env.local as VITE_VAPID_PUBLIC_KEY):

    ${publicKey}

  Private key (SECRET — never commit this):

    ${privateKey}

Set them with:

  npx wrangler secret put VAPID_PUBLIC_KEY
  npx wrangler secret put VAPID_PRIVATE_KEY
  npx wrangler secret put VAPID_SUBJECT      # e.g. mailto:you@example.com
`);
