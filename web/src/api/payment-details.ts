import type { PaymentDetails, SavePaymentDetailsInput } from '@futsal/shared';
import { del, get, put } from './client.js';

export const getPaymentDetails = (signal?: AbortSignal) =>
  get<{ details: PaymentDetails | null }>('/payment-details', signal).then((r) => r.details);

export const savePaymentDetails = (input: SavePaymentDetailsInput) =>
  put<{ details: PaymentDetails }>('/payment-details', input).then((r) => r.details);

export const clearPaymentDetails = () => del<{ ok: true }>('/payment-details');
