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
