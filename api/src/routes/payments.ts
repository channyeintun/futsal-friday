import {
  DEFAULT_GRANULARITY,
  LOBBY_CHANNEL,
  type Session,
  claimPaymentSchema,
  overridePaymentSchema,
  reviewPaymentSchema,
  sessionChannel,
  settleSessionSchema,
  splitWithOverrides,
} from '@futsal/shared';
import { Hono } from 'hono';
import {
  type PaymentRow,
  getSessionRow,
  listPayments,
  listRegistrations,
  loadPaymentSummary,
  toPayment,
} from '../db.js';
import type { AppContext } from '../env.js';
import { conflict, forbidden, newId, notFound, nowIso, parseBody } from '../http.js';
import { requireOrganizer } from '../middleware.js';

/**
 * Money routes.
 *
 * The split is *derived*, never accumulated: settling recomputes every share
 * from the total charge and the current overrides. Editing one person's amount
 * therefore re-balances everybody else automatically, and re-settling the same
 * session twice produces the same numbers instead of drifting.
 */
export const paymentRoutes = new Hono<AppContext>()

  /** Enter the field charge and split it. Also marks the session completed. */
  .post('/sessions/:id/settle', requireOrganizer(), async (c) => {
    const sessionId = c.req.param('id');
    const input = await parseBody(c.req.raw, settleSessionSchema);

    const session = await getSessionRow(c.env.DB, sessionId);
    if (!session) throw notFound('No such session');
    if (session.status === 'cancelled') throw conflict('That session was cancelled');

    const overrides = new Map<string, number | null>();
    for (const o of input.overrides ?? []) overrides.set(o.memberId, o.amount);

    await applySplit(c.env.DB, session, input.totalCharge, overrides, input.granularity);

    const timestamp = nowIso();
    await c.env.DB.prepare(
      `UPDATE sessions SET total_charge = ?2, status = 'completed', updated_at = ?3 WHERE id = ?1`,
    )
      .bind(sessionId, input.totalCharge, timestamp)
      .run();

    const updated = await getSessionRow(c.env.DB, sessionId);
    if (!updated) throw notFound('No such session');

    // One event for the whole settlement rather than one per player: a 15-person
    // session would otherwise cost 15 emits (45 Redis commands) for what is a
    // single logical change.
    await c.get('pubsub').emit([sessionChannel(sessionId), LOBBY_CHANNEL], 'session.updated', {
      sessionId,
      status: updated.status,
      startsAt: updated.startsAt,
      venueId: updated.venueId,
      reason: 'settled',
      at: timestamp,
    });

    return c.json(await loadPaymentSummary(c.env.DB, updated));
  })

  .get('/sessions/:id/payments', async (c) => {
    const session = await getSessionRow(c.env.DB, c.req.param('id'));
    if (!session) throw notFound('No such session');
    return c.json(await loadPaymentSummary(c.env.DB, session));
  })

  /** "I've transferred it" — optionally with a screenshot. */
  .post('/sessions/:id/payments/me/claim', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');
    const input = await parseBody(c.req.raw, claimPaymentSchema);

    const payment = await findPayment(c.env.DB, sessionId, identity.memberId);
    if (!payment) throw notFound('Nothing to pay for this session yet');
    if (payment.status === 'confirmed') throw conflict('That payment is already confirmed');

    const timestamp = nowIso();
    await c.env.DB.prepare(
      `UPDATE payments
          SET status = 'pending', claimed_at = ?2, proof_key = COALESCE(?3, proof_key),
              note = ?4, reject_reason = NULL, updated_at = ?2
        WHERE id = ?1`,
    )
      .bind(payment.id, timestamp, input.proofKey ?? null, input.note ?? null)
      .run();

    const updated = await findPaymentById(c.env.DB, payment.id);
    await c.get('pubsub').emit(sessionChannel(sessionId), 'payment.claimed', {
      sessionId,
      memberId: identity.memberId,
      memberName: identity.name,
      amountDue: payment.amount_due,
      hasProof: updated?.proof_key != null,
      at: timestamp,
    });

    return c.json({ payment: updated ? toPayment(updated) : null });
  })

  /** Undo a claim made by mistake, as long as it is still unreviewed. */
  .delete('/sessions/:id/payments/me/claim', async (c) => {
    const sessionId = c.req.param('id');
    const identity = c.get('identity');

    const payment = await findPayment(c.env.DB, sessionId, identity.memberId);
    if (!payment) throw notFound('Nothing to pay for this session yet');
    if (payment.status === 'confirmed') throw conflict('That payment is already confirmed');

    const timestamp = nowIso();
    await c.env.DB.prepare(
      `UPDATE payments SET status = 'unpaid', claimed_at = NULL, updated_at = ?2 WHERE id = ?1`,
    )
      .bind(payment.id, timestamp)
      .run();

    const updated = await findPaymentById(c.env.DB, payment.id);
    return c.json({ payment: updated ? toPayment(updated) : null });
  })

  /** Organizer verdict on a claimed payment. */
  .post('/payments/:paymentId/review', requireOrganizer(), async (c) => {
    const paymentId = c.req.param('paymentId');
    const input = await parseBody(c.req.raw, reviewPaymentSchema);
    const identity = c.get('identity');

    const payment = await findPaymentById(c.env.DB, paymentId);
    if (!payment) throw notFound('No such payment');

    const timestamp = nowIso();

    if (input.decision === 'confirm') {
      await c.env.DB.prepare(
        `UPDATE payments
            SET status = 'confirmed', confirmed_at = ?2, confirmed_by = ?3,
                reject_reason = NULL, updated_at = ?2
          WHERE id = ?1`,
      )
        .bind(paymentId, timestamp, identity.memberId)
        .run();

      await c.get('pubsub').emit(sessionChannel(payment.session_id), 'payment.confirmed', {
        sessionId: payment.session_id,
        memberId: payment.member_id,
        memberName: payment.member_name,
        amountDue: payment.amount_due,
        at: timestamp,
      });
    } else {
      // Back to unpaid, keeping the screenshot so the two of them can compare
      // notes about what went wrong.
      await c.env.DB.prepare(
        `UPDATE payments
            SET status = 'unpaid', claimed_at = NULL, confirmed_at = NULL,
                reject_reason = ?3, updated_at = ?2
          WHERE id = ?1`,
      )
        .bind(paymentId, timestamp, input.reason ?? null)
        .run();

      await c.get('pubsub').emit(sessionChannel(payment.session_id), 'payment.rejected', {
        sessionId: payment.session_id,
        memberId: payment.member_id,
        memberName: payment.member_name,
        reason: input.reason ?? null,
        at: timestamp,
      });
    }

    const updated = await findPaymentById(c.env.DB, paymentId);
    return c.json({ payment: updated ? toPayment(updated) : null });
  })

  /**
   * Pin one person's amount (someone brought the ball, someone left at half
   * time). Everyone else's share is recomputed from what is left.
   */
  .patch('/payments/:paymentId/override', requireOrganizer(), async (c) => {
    const paymentId = c.req.param('paymentId');
    const input = await parseBody(c.req.raw, overridePaymentSchema);

    const payment = await findPaymentById(c.env.DB, paymentId);
    if (!payment) throw notFound('No such payment');

    const session = await getSessionRow(c.env.DB, payment.session_id);
    if (!session) throw notFound('No such session');
    if (session.totalCharge == null) throw conflict('Settle the session before editing amounts');

    await applySplit(
      c.env.DB,
      session,
      session.totalCharge,
      new Map([[payment.member_id, input.amount]]),
    );

    await c.get('pubsub').emit(sessionChannel(session.id), 'session.updated', {
      sessionId: session.id,
      status: session.status,
      startsAt: session.startsAt,
      venueId: session.venueId,
      reason: 'settled',
      at: nowIso(),
    });

    return c.json(await loadPaymentSummary(c.env.DB, session));
  })

  /**
   * Stream a payment screenshot out of R2.
   *
   * Object keys never leave the server: the only way to read a proof is through
   * this route, which is restricted to the organizer and the member who
   * uploaded it.
   */
  .get('/payments/:paymentId/proof', async (c) => {
    const paymentId = c.req.param('paymentId');
    const identity = c.get('identity');

    const payment = await findPaymentById(c.env.DB, paymentId);
    if (!payment) throw notFound('No such payment');
    if (!identity.isOrganizer && payment.member_id !== identity.memberId) throw forbidden();
    if (!payment.proof_key) throw notFound('No screenshot attached');

    const object = await c.env.PROOFS.get(payment.proof_key);
    if (!object) throw notFound('Screenshot is no longer stored');

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': 'inline',
      },
    });
  });

/* --------------------------------------------------------------- helpers */

/**
 * Recompute and persist every player's share.
 *
 * `newOverrides` is merged over the overrides already stored, so callers can
 * change one amount without restating the rest. Existing payment *status* is
 * untouched — re-splitting must not un-confirm somebody who has already paid.
 */
async function applySplit(
  db: D1Database,
  session: Session,
  totalCharge: number,
  newOverrides: Map<string, number | null>,
  granularity: number = DEFAULT_GRANULARITY,
): Promise<void> {
  const registrations = await listRegistrations(db, session.id);
  // Waitlisted people never played, so they never owe anything.
  const players = registrations.filter((r) => r.status === 'in');
  if (players.length === 0) throw conflict('Nobody was registered for that session');

  const existing = await listPayments(db, session.id);
  const overrides = new Map<string, number | null>();
  for (const p of existing) overrides.set(p.memberId, p.amountOverride);
  for (const [memberId, amount] of newOverrides) overrides.set(memberId, amount);

  const shares = splitWithOverrides(
    totalCharge,
    players.map((p) => ({ id: p.memberId, override: overrides.get(p.memberId) ?? null })),
    granularity,
  );

  const timestamp = nowIso();
  const statements = players.map((player) =>
    db
      .prepare(
        `INSERT INTO payments
           (id, session_id, member_id, amount_due, amount_override, status,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'unpaid', ?6, ?6)
         ON CONFLICT (session_id, member_id) DO UPDATE SET
           amount_due = excluded.amount_due,
           amount_override = excluded.amount_override,
           updated_at = excluded.updated_at`,
      )
      .bind(
        newId('pay'),
        session.id,
        player.memberId,
        shares.get(player.memberId) ?? 0,
        overrides.get(player.memberId) ?? null,
        timestamp,
      ),
  );

  // Someone who was settled and then removed from the list should stop owing
  // money — but only if they had not already paid, so history is never erased.
  const playerIds = players.map((p) => p.memberId);
  const placeholders = playerIds.map((_, i) => `?${i + 2}`).join(', ');
  statements.push(
    db
      .prepare(
        `DELETE FROM payments
          WHERE session_id = ?1 AND status = 'unpaid'
            AND member_id NOT IN (${placeholders})`,
      )
      .bind(session.id, ...playerIds),
  );

  await db.batch(statements);
}

function findPayment(
  db: D1Database,
  sessionId: string,
  memberId: string,
): Promise<PaymentRow | null> {
  return db
    .prepare(
      `SELECT p.*, m.name AS member_name FROM payments p
         JOIN members m ON m.id = p.member_id
        WHERE p.session_id = ?1 AND p.member_id = ?2`,
    )
    .bind(sessionId, memberId)
    .first<PaymentRow>();
}

function findPaymentById(db: D1Database, paymentId: string): Promise<PaymentRow | null> {
  return db
    .prepare(
      `SELECT p.*, m.name AS member_name FROM payments p
         JOIN members m ON m.id = p.member_id
        WHERE p.id = ?1`,
    )
    .bind(paymentId)
    .first<PaymentRow>();
}
