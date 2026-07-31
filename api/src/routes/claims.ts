import type { ClaimLink } from '@futsal/shared';
import { Hono } from 'hono';
import { type MemberRow } from '../db.js';
import type { AppContext } from '../env.js';
import { conflict, notFound, nowIso } from '../http.js';
import { CLAIM_TTL_MS, newClaimNonce } from '../identity/index.js';
import { requireOrganizer } from '../middleware.js';

/**
 * Issuing and revoking claim links.
 *
 * Two audiences: the organizer, handing out identities to the group; and a
 * member adding their own second device, which they can do without waiting on
 * anybody — they are already authenticated, so letting them mint a link for
 * themselves grants no access they do not already have.
 */
export const claimRoutes = new Hono<AppContext>()

  /** Organizer: mint a link for someone. Replaces any outstanding one. */
  .post('/members/:id/claim-link', requireOrganizer(), async (c) => {
    const id = c.req.param('id');

    const member = await c.env.DB.prepare(
      `SELECT * FROM members WHERE id = ?1 AND active = 1`,
    )
      .bind(id)
      .first<MemberRow>();
    if (!member) throw notFound('No such member');

    return c.json(await mintLink(c.env.DB, c.env.APP_URL, member));
  })

  /**
   * A member adding another device.
   *
   * Without this, every new phone or laptop would need the organizer, which is
   * the kind of friction that ends with people sharing one login.
   */
  .post('/auth/my-device-link', async (c) => {
    const identity = c.get('identity');

    const member = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(identity.memberId)
      .first<MemberRow>();
    if (!member) throw notFound('No such member');

    return c.json(await mintLink(c.env.DB, c.env.APP_URL, member));
  })

  /**
   * Organizer: cut a member off.
   *
   * Bumping `token_version` invalidates every session token that member holds,
   * which is what "I lost my phone" actually requires — the tokens are
   * stateless and otherwise good for 90 days. Any outstanding link is dropped
   * at the same time, and `claimed_at` is cleared so the roster shows them as
   * needing a fresh invitation.
   */
  .delete('/members/:id/claim', requireOrganizer(), async (c) => {
    const id = c.req.param('id');
    const identity = c.get('identity');

    const member = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(id)
      .first<MemberRow>();
    if (!member) throw notFound('No such member');

    // Signing yourself out of the app you are using to do it, with no link in
    // hand, is a lockout waiting to happen.
    if (id === identity.memberId) {
      throw conflict('Use "Add another device" to move yourself, or sign out normally');
    }

    await c.env.DB.prepare(
      `UPDATE members
          SET token_version = token_version + 1,
              claim_nonce = NULL,
              claim_expires_at = NULL,
              claimed_at = NULL
        WHERE id = ?1`,
    )
      .bind(id)
      .run();

    return c.json({ ok: true });
  });

async function mintLink(db: D1Database, appUrl: string, member: MemberRow): Promise<ClaimLink> {
  const nonce = newClaimNonce();
  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  await db
    .prepare(`UPDATE members SET claim_nonce = ?2, claim_expires_at = ?3 WHERE id = ?1`)
    .bind(member.id, nonce, expiresAt)
    .run();

  return {
    // The nonce goes in the fragment: browsers never put it in the request
    // line, so it stays out of server logs, proxy logs and Referer headers.
    url: `${appUrl.replace(/\/$/, '')}/claim#${nonce}`,
    expiresAt,
    memberName: member.name,
  };
}
