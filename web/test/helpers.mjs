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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * A finished match with no bill entered yet.
 *
 * The payments suite needs one to reach the split form, and used to hope the
 * dev database happened to contain one — quietly running no assertions at all
 * when it did not, while still reporting every check green. Seeding it makes
 * the precondition a fact rather than a wish.
 *
 * Placed a couple of hours ago so it is the newest past session and therefore
 * certain to be inside the twelve the home screen lists.
 */
export function localUnsettledSession(memberIds = []) {
  const id = `ses_test_${randomBytes(6).toString('hex')}`;
  // Jittered: a partial unique index forbids two non-cancelled sessions
  // starting at the same instant, and a fixed offset would collide with a
  // leftover from an interrupted run.
  const startsAt = new Date(Date.now() - 2 * 3_600_000 - Math.floor(Math.random() * 3_600_000))
    .toISOString();

  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--command',
     // total_charge stays NULL: that is what "not split" means, and what puts
     // the split form on the payments screen.
     `INSERT INTO sessions (id, starts_at, status, max_players, created_at, updated_at)
        VALUES ('${id}', '${startsAt}', 'completed', 12, '${startsAt}', '${startsAt}');`],
    { cwd: API_DIR, encoding: 'utf8', stdio: 'pipe' },
  );

  memberIds.forEach((memberId, index) => {
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--command',
       `INSERT INTO registrations (id, session_id, member_id, status, position, created_at)
          VALUES ('reg_test_${randomBytes(5).toString('hex')}', '${id}', '${memberId}',
                  'in', ${index}, '${startsAt}');`],
      { cwd: API_DIR, encoding: 'utf8', stdio: 'pipe' },
    );
  });

  return id;
}

/** Remove seeded sessions. Registrations and payments go with them. */
export function clearTestSessions() {
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'futsal-friday', '--local', '--command',
     `DELETE FROM sessions WHERE id LIKE 'ses_test_%';`],
    { cwd: API_DIR, encoding: 'utf8', stdio: 'pipe' },
  );
}

/**
 * Load the real `@futsal/shared` into a plain-Node test.
 *
 * The browser suites are `.mjs` run straight by Node, which cannot resolve the
 * workspace's TypeScript sources. Bundling the actual module is the point: a
 * re-implementation of, say, the VietQR encoder inside a test would agree with
 * itself when both copies are wrong, which is exactly the bug worth catching.
 */
export async function loadShared() {
  const out = join(tmpdir(), `ff-shared-${process.pid}.mjs`);
  execFileSync(
    'npx',
    ['esbuild', 'src/index.ts', '--bundle', '--platform=node', '--format=esm',
     `--outfile=${out}`, '--log-level=error'],
    { cwd: join(API_DIR, '..', 'shared'), encoding: 'utf8', stdio: 'pipe' },
  );
  return import(pathToFileURL(out).href);
}
