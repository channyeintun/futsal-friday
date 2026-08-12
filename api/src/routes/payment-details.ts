import { type PaymentDetails, savePaymentDetailsSchema } from '@futsal/shared';
import { Hono } from 'hono';
import type { AppContext } from '../env.js';
import { nowIso, parseBody } from '../http.js';
import { requireOrganizer } from '../middleware.js';

interface PaymentDetailsRow {
  bank_bin: string;
  bank_name: string;
  account_number: string;
  account_name: string;
  note: string | null;
  updated_at: string;
}

const toDetails = (row: PaymentDetailsRow): PaymentDetails => ({
  bankBin: row.bank_bin,
  bankName: row.bank_name,
  accountNumber: row.account_number,
  accountName: row.account_name,
  note: row.note,
  updatedAt: row.updated_at,
});

/**
 * Where the group sends money.
 *
 * Readable by every member and writable only by organizers. That asymmetry is
 * the whole feature: the details stop living in a chat message somebody has to
 * scroll back for, without letting anyone quietly redirect the group's
 * transfers to themselves.
 */
export const paymentDetailsRoutes = new Hono<AppContext>()

  .get('/payment-details', async (c) => {
    const row = await c.env.DB.prepare(`SELECT * FROM payment_details WHERE id = 1`).first<PaymentDetailsRow>();
    return c.json({ details: row ? toDetails(row) : null });
  })

  .put('/payment-details', requireOrganizer(), async (c) => {
    const input = await parseBody(c.req.raw, savePaymentDetailsSchema);
    const identity = c.get('identity');
    const timestamp = nowIso();

    await c.env.DB.prepare(
      `INSERT INTO payment_details
         (id, bank_bin, bank_name, account_number, account_name, note, updated_at, updated_by)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (id) DO UPDATE SET
         bank_bin = excluded.bank_bin,
         bank_name = excluded.bank_name,
         account_number = excluded.account_number,
         account_name = excluded.account_name,
         note = excluded.note,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
      .bind(
        input.bankBin,
        input.bankName,
        input.accountNumber,
        input.accountName,
        input.note ?? null,
        timestamp,
        identity.memberId,
      )
      .run();

    return c.json({ details: { ...input, note: input.note ?? null, updatedAt: timestamp } });
  })

  /** Taking the details down is how an organizer stops collecting this way. */
  .delete('/payment-details', requireOrganizer(), async (c) => {
    await c.env.DB.prepare(`DELETE FROM payment_details WHERE id = 1`).run();
    return c.json({ ok: true });
  });
