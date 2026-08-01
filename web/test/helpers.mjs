/**
 * Shared bits for the browser suites.
 *
 * Signing in is now a claim link, so a test cannot just type a shared code —
 * it has to be *invited*. For local runs that means writing a nonce straight
 * into the dev database, which is the same documented escape hatch a real
 * organizer uses to bootstrap themselves.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'api');

/**
 * Mint a claim nonce for a member directly in the local D1, and return the
 * path a browser should open.
 */
export function localClaimPath(memberId = 'mem_organizer') {
  const nonce = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 3_600_000).toISOString();

  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--command',
     `UPDATE members SET claim_nonce='${nonce}', claim_expires_at='${expires}' WHERE id='${memberId}';`],
    { cwd: API_DIR, encoding: 'utf8', stdio: 'pipe' },
  );

  return `/claim#${nonce}`;
}

/** The id of the first organizer in the local database. */
export function localOrganizerId() {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--json', '--command',
     `SELECT id FROM members WHERE is_organizer = 1 AND active = 1 ORDER BY created_at LIMIT 1;`],
    { cwd: API_DIR, encoding: 'utf8', stdio: 'pipe' },
  );
  return JSON.parse(out)[0].results[0].id;
}

/**
 * Create the group invite directly in the local D1 and return the path a
 * browser should open. Mirrors what the organizer's Setup screen does.
 */
export function localGroupJoinPath() {
  const nonce = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();

  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--command',
     `INSERT INTO group_invite (id, nonce, expires_at, created_at)
        VALUES (1, '${nonce}', '${expires}', '${now}')
        ON CONFLICT (id) DO UPDATE
          SET nonce = excluded.nonce, expires_at = excluded.expires_at;`],
    { cwd: API_DIR, encoding: 'utf8', stdio: 'pipe' },
  );

  return `/join#${nonce}`;
}

/** Add an unclaimed member so the join screen has something to offer. */
export function localUnclaimedMember(name) {
  const id = `mem_test_${randomBytes(6).toString('hex')}`;
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--command',
     // approved_at set: this stands in for a member the organizer typed in,
     // not somebody who added themselves and is waiting to be let in.
     `INSERT INTO members (id, name, is_organizer, active, created_at, approved_at)
        VALUES ('${id}', '${name.replace(/'/g, "''")}', 0, 1,
                '${new Date().toISOString()}', '${new Date().toISOString()}');`],
    { cwd: API_DIR, encoding: 'utf8', stdio: 'pipe' },
  );
  return id;
}

/** Wipe test members so repeated runs start from the same place. */
export function clearTestMembers() {
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--command',
     // Anything a suite invented. The suffix convention is what keeps this
     // from touching a real roster if it is ever pointed at one.
     `DELETE FROM members WHERE id LIKE 'mem_test_%' OR name LIKE '%-Test';`],
    { cwd: API_DIR, encoding: 'utf8', stdio: 'pipe' },
  );
}

/**
 * Let everybody in the waiting room through, straight in the database.
 *
 * The browser suite has no organizer session to approve with — the point of
 * that suite is the *other* side of the flow — so it approves the same way the
 * endpoint does and checks that the pending client notices.
 */
export function approveEveryonePending() {
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--command',
     `UPDATE members SET approved_at = '${new Date().toISOString()}' WHERE approved_at IS NULL;`],
    { cwd: API_DIR, encoding: 'utf8', stdio: 'pipe' },
  );
}
