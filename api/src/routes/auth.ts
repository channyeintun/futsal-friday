import { gateSchema, joinSchema } from '@futsal/shared';
import { Hono } from 'hono';
import { type MemberRow, toMember } from '../db.js';
import type { AppContext } from '../env.js';
import { badRequest, parseBody, unauthorized } from '../http.js';
import { issueGateToken, tokenIdentityProvider, verifyGateToken } from '../identity/index.js';
import { timingSafeEqual } from '../identity/tokens.js';
import { requireMember } from '../middleware.js';

/**
 * Two-step entry, deliberately not an auth system.
 *
 *   1. `POST /gate` — prove you know the group's invite code. Only then does
 *      the API reveal who is in the group.
 *   2. `POST /join` — say which of those people you are, and get a token.
 *
 * Step 2 is on the honour system: anyone past the gate could claim to be
 * anyone. That is the right trade for ~15 friends splitting a pitch fee — the
 * invite code is the real boundary. Swapping in a provider that supplies a
 * verified user id is a job for `IdentityProvider`, not for this route.
 */
export const authRoutes = new Hono<AppContext>()

  .post('/gate', async (c) => {
    const { code } = await parseBody(c.req.raw, gateSchema);

    if (!c.env.GROUP_INVITE_CODE) {
      throw badRequest('Server is missing GROUP_INVITE_CODE', 'internal');
    }
    if (!timingSafeEqual(code, c.env.GROUP_INVITE_CODE)) {
      throw unauthorized('That invite code is not right');
    }

    const { results } = await c.env.DB.prepare(
      `SELECT * FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE ASC`,
    ).all<MemberRow>();

    return c.json({
      gateToken: await issueGateToken(c.env),
      members: results.map(toMember),
    });
  })

  .post('/join', async (c) => {
    const { gateToken, memberId } = await parseBody(c.req.raw, joinSchema);

    if (!(await verifyGateToken(c.env, gateToken))) {
      throw unauthorized('Enter the invite code again');
    }

    const row = await c.env.DB.prepare(`SELECT * FROM members WHERE id = ?1 AND active = 1`)
      .bind(memberId)
      .first<MemberRow>();
    if (!row) throw badRequest('That member no longer exists');

    const member = toMember(row);
    const identity = {
      memberId: member.id,
      name: member.name,
      isOrganizer: member.isOrganizer,
      language: member.language,
    };

    const credential = await tokenIdentityProvider.issue(identity, c.env);
    if (credential.setCookie) c.header('Set-Cookie', credential.setCookie);

    return c.json({ token: credential.token, identity });
  })

  .get('/me', requireMember(), (c) => c.json({ identity: c.get('identity') }))

  .post('/logout', (c) => {
    const { setCookie } = tokenIdentityProvider.revoke();
    if (setCookie) c.header('Set-Cookie', setCookie);
    return c.json({ ok: true });
  });
