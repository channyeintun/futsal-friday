import { claimSchema } from '@futsal/shared';
import { Hono } from 'hono';
import { type MemberRow, toMember } from '../db.js';
import type { AppContext } from '../env.js';
import { nowIso, parseBody, unauthorized } from '../http.js';
import { tokenIdentityProvider } from '../identity/index.js';
import { requireMember } from '../middleware.js';

/**
 * Getting in.
 *
 * There is exactly one way: redeem a claim link the organizer sent you. There
 * is no name picker and no shared password.
 *
 * The previous design — a group-wide invite code plus "pick who you are" — had
 * two problems that only look small until you think about money. Anyone holding
 * the code could pick *any* name, including an organizer's, which made
 * privilege escalation a two-tap operation; and the code itself sits in a group
 * chat forever, so it never really expires. A per-person, single-use link fixes
 * both: it names its holder, it is spent on first use, and it can be reissued
 * without disturbing anybody else.
 */
export const authRoutes = new Hono<AppContext>()

  /**
   * Redeem a link. The nonce is looked up directly — the row is the proof —
   * and cleared in the same statement, so a forwarded link is worthless once
   * the first person has opened it.
   */
  .post('/claim', async (c) => {
    const { nonce } = await parseBody(c.req.raw, claimSchema);
    const timestamp = nowIso();

    const row = await c.env.DB.prepare(
      `SELECT * FROM members
        WHERE claim_nonce = ?1 AND active = 1 AND claim_expires_at > ?2`,
    )
      .bind(nonce, timestamp)
      .first<MemberRow>();

    // One message for "wrong", "expired" and "already used": distinguishing
    // them would tell a stranger which of those a value happens to be.
    if (!row) throw unauthorized('That link is not valid any more. Ask for a new one.');

    // Spend it. Guarded on the nonce so two simultaneous opens cannot both win.
    const spent = await c.env.DB.prepare(
      `UPDATE members
          SET claim_nonce = NULL,
              claim_expires_at = NULL,
              claimed_at = COALESCE(claimed_at, ?2)
        WHERE id = ?1 AND claim_nonce = ?3`,
    )
      .bind(row.id, timestamp, nonce)
      .run();

    if (spent.meta.changes === 0) {
      throw unauthorized('That link is not valid any more. Ask for a new one.');
    }

    const member = toMember(row);
    const identity = {
      memberId: member.id,
      name: member.name,
      isOrganizer: member.isOrganizer,
      language: member.language,
      approved: member.approvedAt !== null,
    };

    const credential = await tokenIdentityProvider.issue(identity, row.token_version, c.env);
    if (credential.setCookie) c.header('Set-Cookie', credential.setCookie);

    return c.json({ token: credential.token, identity });
  })

  .get('/me', requireMember(), (c) => c.json({ identity: c.get('identity') }))

  .post('/logout', (c) => {
    const { setCookie } = tokenIdentityProvider.revoke();
    if (setCookie) c.header('Set-Cookie', setCookie);
    return c.json({ ok: true });
  });
