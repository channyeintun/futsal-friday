import type {
  ClaimPaymentInput,
  Payment,
  PaymentSummary,
  ReviewPaymentInput,
  SettleSessionInput,
} from '@futsal/shared';
import { platform } from '../platform/index.js';
import { del, get, getBlob, patch, post, request } from './client.js';

export const getPayments = (sessionId: string, signal?: AbortSignal) =>
  get<PaymentSummary>(`/sessions/${sessionId}/payments`, signal);

export const settleSession = (sessionId: string, input: SettleSessionInput) =>
  post<PaymentSummary>(`/sessions/${sessionId}/settle`, input);

export const claimPayment = (sessionId: string, input: ClaimPaymentInput) =>
  post<{ payment: Payment }>(`/sessions/${sessionId}/payments/me/claim`, input).then(
    (r) => r.payment,
  );

export const unclaimPayment = (sessionId: string) =>
  del<{ payment: Payment }>(`/sessions/${sessionId}/payments/me/claim`).then((r) => r.payment);

export const reviewPayment = (paymentId: string, input: ReviewPaymentInput) =>
  post<{ payment: Payment }>(`/payments/${paymentId}/review`, input).then((r) => r.payment);

export const overridePayment = (paymentId: string, amount: number | null) =>
  patch<PaymentSummary>(`/payments/${paymentId}/override`, { amount });

/**
 * Shrink a screenshot in the browser, then upload the bytes.
 *
 * The compression is not a nicety: a raw phone screenshot is 2-4 MB, and the
 * Worker rejects anything over 1 MB precisely because it has no way to resize
 * one itself.
 */
export async function uploadProof(sessionId: string, file: Blob): Promise<string> {
  const compressed = await platform.compressImage(file);
  const result = await request<{ key: string }>(
    'POST',
    `/uploads/proof?sessionId=${encodeURIComponent(sessionId)}`,
    { raw: compressed.blob, contentType: compressed.contentType },
  );
  return result.key;
}

/**
 * Load a proof image for display. The caller owns the returned URL and must
 * pass it to `platform.objectUrl.revoke` when the view goes away.
 *
 * `version` is in the query string to give each screenshot its own address. A
 * rejected payment can be claimed again with a different picture and keeps its
 * id when it is, so without it the address outlives what it points at, and a
 * reply cacheable for an hour is what the browser produces instead of the new
 * screenshot. `updatedAt` moves whenever the payment does, which is more often
 * than the screenshot changes and never less.
 */
export async function loadProofUrl(
  paymentId: string,
  version: string,
  signal?: AbortSignal,
): Promise<string> {
  const asked = version ? `?v=${encodeURIComponent(version)}` : '';
  const blob = await getBlob(`/payments/${paymentId}/proof${asked}`, signal);
  return platform.objectUrl.create(blob);
}
