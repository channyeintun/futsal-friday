import { Hono } from 'hono';
import type { AppContext } from '../env.js';
import { apiError, badRequest, conflict, newId } from '../http.js';

/**
 * Payment screenshot upload.
 *
 * Images are resized and re-encoded in the browser before they get here (see
 * `web/src/platform/images.ts`), so this endpoint's job is to be strict about
 * what it accepts rather than to do any processing of its own — a Worker has
 * neither the CPU budget nor an image library for that.
 *
 * ## R2 free-tier arithmetic
 *
 * The free bucket is 10 GB with no egress charge. At the ~150 KB the client
 * compressor targets, 15 players × 52 weeks is roughly 120 MB/year — about 1%
 * of the allowance per year. The hard cap below is what stops an unresized
 * 12-megapixel photo from turning that estimate into a lie.
 */

/** Comfortably above the client's ~150 KB target, far below an original photo. */
const MAX_BYTES = 1_000_000;

const ALLOWED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const uploadRoutes = new Hono<AppContext>().post('/proof', async (c) => {
  const sessionId = c.req.query('sessionId');
  if (!sessionId) throw badRequest('sessionId query parameter is required');

  const identity = c.get('identity');
  const contentType = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim() ?? '';

  const extension = ALLOWED[contentType];
  if (!extension) throw badRequest('Upload a JPEG, PNG or WebP image');

  // Only somebody who actually owes money for this session can attach a
  // screenshot to it — that also bounds how many objects can ever be written.
  const owes = await c.env.DB.prepare(
    `SELECT 1 FROM payments WHERE session_id = ?1 AND member_id = ?2`,
  )
    .bind(sessionId, identity.memberId)
    .first<{ 1: number }>();
  if (!owes) throw conflict('You have nothing to pay for that session');

  // Reject on the declared length first so an oversized body is not streamed
  // into the Worker at all; the real check follows, since the header lies.
  const declared = Number.parseInt(c.req.header('Content-Length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw tooLarge();

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) throw badRequest('Empty upload');
  if (body.byteLength > MAX_BYTES) throw tooLarge();

  const key = `proofs/${sessionId}/${identity.memberId}/${newId('img')}.${extension}`;
  await c.env.PROOFS.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: { memberId: identity.memberId, sessionId },
  });

  // The key is opaque to the client: it is echoed back only so it can be
  // attached to the payment claim. Reading an image always goes through the
  // authorized `/payments/:id/proof` route.
  return c.json({ key }, 201);
});

function tooLarge() {
  return apiError(
    413,
    'payload_too_large',
    `Image is too large — keep it under ${Math.round(MAX_BYTES / 1000)} KB`,
  );
}
