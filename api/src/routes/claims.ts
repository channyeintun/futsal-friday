import type { ClaimLink, GroupInvite, JoinableMember } from '@futsal/shared';
import { groupClaimSchema, groupJoinSchema } from '@futsal/shared';
import { Hono } from 'hono';
import { type MemberRow, toMember } from '../db.js';
import type { AppContext } from '../env.js';
import { conflict, notFound, nowIso, parseBody, unauthorized } from '../http.js';
import {
  CLAIM_TTL_MS,
  GROUP_INVITE_TTL_MS,
  newClaimNonce,
  tokenIdentityProvider,
} from '../identity/index.js';
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

/* ------------------------------------------------------- group invite ---- */

/**
 * The link the organizer pastes into the group chat, once.
 *
 * A chat message is not a secret, so this link is not treated as one. What
 * makes it safe is what redeeming it is allowed to do: claim exactly one
 * unclaimed, non-organizer name. Everything else is refused server-side.
 */
export const groupInviteRoutes = new Hono<AppContext>()

  .get('/group-invite', requireOrganizer(), async (c) => {
    const row = await c.env.DB.prepare(`SELECT * FROM group_invite WHERE id = 1`).first<{
      nonce: string;
      expires_at: string;
    }>();
    if (!row || row.expires_at <= nowIso()) return c.json({ invite: null });

    return c.json({ invite: await describeInvite(c.env.DB, c.env.APP_URL, row) });
  })

  /** Create or rotate it. Rotating kills the copy sitting in the chat history. */
  .post('/group-invite', requireOrganizer(), async (c) => {
    const identity = c.get('identity');
    const nonce = newClaimNonce();
    const expiresAt = new Date(Date.now() + GROUP_INVITE_TTL_MS).toISOString();

    await c.env.DB.prepare(
      `INSERT INTO group_invite (id, nonce, expires_at, created_at, created_by)
       VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET
         nonce = excluded.nonce,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at,
         created_by = excluded.created_by`,
    )
      .bind(nonce, expiresAt, nowIso(), identity.memberId)
      .run();

    return c.json({
      invite: await describeInvite(c.env.DB, c.env.APP_URL, { nonce, expires_at: expiresAt }),
    });
  });

/**
 * Public endpoints behind the group link. Unauthenticated by necessity — the
 * whole point is that nobody has credentials yet — so every restriction lives
 * in the SQL below.
 */
export const groupJoinRoutes = new Hono<AppContext>()

  /** The names still up for grabs. Reveals nothing else about the group. */
  .post('/auth/group/roster', async (c) => {
    const { nonce } = await parseBody(c.req.raw, groupJoinSchema);
    await requireValidGroupNonce(c.env.DB, nonce);

    const { results } = await c.env.DB.prepare(joinableQuery).all<{ id: string; name: string }>();
    const members: JoinableMember[] = results.map((r) => ({ id: r.id, name: r.name }));
    return c.json({ members });
  })

  /** Take a name. It locks to this device and leaves the list for good. */
  .post('/auth/group/claim', async (c) => {
    const { nonce, memberId } = await parseBody(c.req.raw, groupClaimSchema);
    await requireValidGroupNonce(c.env.DB, nonce);

    const timestamp = nowIso();

    // Guarded in the statement, not before it: `claimed_at IS NULL` is what
    // makes two people racing for the same name resolve to one winner, and
    // `is_organizer = 0` is what stops admin being claimed this way.
    const taken = await c.env.DB.prepare(
      `UPDATE members
          SET claimed_at = ?2, claim_nonce = NULL, claim_expires_at = NULL
        WHERE id = ?1 AND active = 1 AND is_organizer = 0 AND claimed_at IS NULL`,
    )
      .bind(memberId, timestamp)
      .run();

    if (taken.meta.changes === 0) {
      throw conflict('Somebody already took that name. Pick another, or ask the organizer.');
    }

    const row = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1`)
      .bind(memberId)
      .first<MemberRow>();
    if (!row) throw notFound('No such member');

    const member = toMember(row);
    const identity = {
      memberId: member.id,
      name: member.name,
      isOrganizer: member.isOrganizer,
      language: member.language,
    };

    const credential = await tokenIdentityProvider.issue(identity, row.token_version, c.env);
    if (credential.setCookie) c.header('Set-Cookie', credential.setCookie);

    return c.json({ token: credential.token, identity });
  });

/**
 * Who the group link may be used to become: active, not yet claimed, and not
 * an organizer. Defined once so the roster and the claim cannot disagree.
 */
const joinableQuery = `
  SELECT id, name FROM members
   WHERE active = 1 AND is_organizer = 0 AND claimed_at IS NULL
   ORDER BY name COLLATE NOCASE ASC
`;

async function requireValidGroupNonce(db: D1Database, nonce: string): Promise<void> {
  const row = await db
    .prepare(`SELECT nonce FROM group_invite WHERE id = 1 AND nonce = ?1 AND expires_at > ?2`)
    .bind(nonce, nowIso())
    .first<{ nonce: string }>();

  if (!row) throw unauthorized('That group link is not valid any more. Ask for a new one.');
}

async function describeInvite(
  db: D1Database,
  appUrl: string,
  row: { nonce: string; expires_at: string },
): Promise<GroupInvite> {
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM (${joinableQuery})`)
    .first<{ n: number }>();

  return {
    url: `${appUrl.replace(/\/$/, '')}/join#${row.nonce}`,
    expiresAt: row.expires_at,
    unclaimed: count?.n ?? 0,
  };
}

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
