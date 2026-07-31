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
 */
export async function loadProofUrl(paymentId: string, signal?: AbortSignal): Promise<string> {
  const blob = await getBlob(`/payments/${paymentId}/proof`, signal);
  return platform.objectUrl.create(blob);
}
