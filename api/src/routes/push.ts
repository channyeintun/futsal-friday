import {
  type PushStatus,
  messagesFor,
  normalizeLocale,
  notificationPrefsSchema,
  pushSubscriptionSchema,
} from '@futsal/shared';
import { Hono } from 'hono';
import { type MemberRow, toMember } from '../db.js';
import type { AppContext } from '../env.js';
import { conflict, newId, nowIso, parseBody } from '../http.js';
import { createPushSender } from '../push/index.js';

/**
 * Reminder subscriptions.
 *
 * A member subscribes per device — the PWA installed on a phone and the same
 * app open on a laptop are two endpoints — so this stores a list, not a flag.
 * Whether they *want* each kind of reminder is a per-member preference on top.
 */
export const pushRoutes = new Hono<AppContext>()

  .get('/status', async (c) => {
    const identity = c.get('identity');
    const sender = createPushSender(c.env);

    const row = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(identity.memberId)
      .first<MemberRow>();
    const count = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = ?1`,
    )
      .bind(identity.memberId)
      .first<{ n: number }>();

    const member = row ? toMember(row) : null;

    const status: PushStatus = {
      enabled: sender.enabled,
      publicKey: sender.publicKey(),
      devices: count?.n ?? 0,
      notifySession: member?.notifySession ?? true,
      notifyPayment: member?.notifyPayment ?? true,
      language: member?.language ?? 'en',
      hour12: (row?.hour12 ?? 0) === 1,
    };
    return c.json(status);
  })

  /**
   * Register a device. Upserts on the endpoint: browsers hand back the same
   * endpoint when a subscription is refreshed, and re-granting permission must
   * not pile up duplicate rows that each send the same notification.
   */
  .post('/subscribe', async (c) => {
    const identity = c.get('identity');
    const input = await parseBody(c.req.raw, pushSubscriptionSchema);

    const sender = createPushSender(c.env);
    if (!sender.enabled) throw conflict('Reminders are not configured on this server');

    const timestamp = nowIso();
    await c.env.DB.prepare(
      `INSERT INTO push_subscriptions
         (id, member_id, endpoint, p256dh, auth, user_agent, created_at, failure_count)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
       ON CONFLICT (endpoint) DO UPDATE SET
         member_id = excluded.member_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         failure_count = 0`,
    )
      .bind(
        newId('sub'),
        identity.memberId,
        input.endpoint,
        input.keys.p256dh,
        input.keys.auth,
        (c.req.header('User-Agent') ?? '').slice(0, 200),
        timestamp,
      )
      .run();

    return c.json({ ok: true });
  })

  .post('/unsubscribe', async (c) => {
    const identity = c.get('identity');
    const body = await c.req.raw
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : null;

    if (endpoint) {
      // Scoped to the caller so one member cannot unsubscribe another's device.
      await c.env.DB.prepare(
        `DELETE FROM push_subscriptions WHERE endpoint = ?1 AND member_id = ?2`,
      )
        .bind(endpoint, identity.memberId)
        .run();
    } else {
      await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE member_id = ?1`)
        .bind(identity.memberId)
        .run();
    }

    return c.json({ ok: true });
  })

  .patch('/preferences', async (c) => {
    const identity = c.get('identity');
    const input = await parseBody(c.req.raw, notificationPrefsSchema);

    const row = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(identity.memberId)
      .first<MemberRow>();
    if (!row) throw conflict('Member no longer exists');

    const next = {
      session: input.notifySession === undefined ? row.notify_session : input.notifySession ? 1 : 0,
      payment: input.notifyPayment === undefined ? row.notify_payment : input.notifyPayment ? 1 : 0,
      language: input.language ?? normalizeLocale(row.language),
      hour12: input.hour12 === undefined ? (row.hour12 ?? 0) : input.hour12 ? 1 : 0,
    };

    await c.env.DB.prepare(
      `UPDATE members
          SET notify_session = ?2, notify_payment = ?3, language = ?4, hour12 = ?5
        WHERE id = ?1`,
    )
      .bind(identity.memberId, next.session, next.payment, next.language, next.hour12)
      .run();

    return c.json({
      notifySession: next.session === 1,
      notifyPayment: next.payment === 1,
      language: next.language,
      hour12: next.hour12 === 1,
    });
  })

  /** Fire a notification at the caller's own devices, to prove it works. */
  .post('/test', async (c) => {
    const identity = c.get('identity');
    const sender = createPushSender(c.env);
    if (!sender.enabled) throw conflict('Reminders are not configured on this server');

    const { results } = await c.env.DB.prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = ?1`,
    )
      .bind(identity.memberId)
      .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();

    if (results.length === 0) throw conflict('No devices are subscribed yet');

    const member = await c.env.DB.prepare(`SELECT language FROM members WHERE id = ?1`)
      .bind(identity.memberId)
      .first<{ language: string }>();
    const messages = messagesFor(normalizeLocale(member?.language));

    const outcomes = await Promise.all(
      results.map((row) =>
        sender.send(
          {
            subscriptionId: row.id,
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          {
            title: messages.push.testTitle,
            body: messages.push.testBody(identity.name),
            tag: 'test',
            url: '/',
          },
        ),
      ),
    );

    // A test that finds a dead endpoint should clean it up, same as the cron.
    const gone = outcomes.filter((o) => o.status === 'gone').map((o) => o.subscriptionId);
    if (gone.length > 0) {
      await c.env.DB.prepare(
        `DELETE FROM push_subscriptions WHERE id IN (${gone.map((_, i) => `?${i + 1}`).join(',')})`,
      )
        .bind(...gone)
        .run();
    }

    return c.json({
      sent: outcomes.filter((o) => o.status === 'sent').length,
      removed: gone.length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
    });
  });
