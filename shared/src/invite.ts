/**
 * Reading an invite out of whatever somebody pasted.
 *
 * An installed PWA has no address bar, so a link cannot be "opened" in it. That
 * is not a rare corner: on iOS, tapping a link inside a chat app opens the
 * in-app webview, whose storage is a different world from the installed app —
 * so somebody can sign in perfectly well and still find their home-screen icon
 * signed out, with nowhere to put the link. Pasting it into a field is the way
 * back, and this turns the paste into something the app can act on.
 *
 * Deliberately forgiving about what arrives. People paste whole URLs, links
 * that a chat client wrapped in tracking parameters, text with the link
 * somewhere in the middle, and occasionally just the code.
 */

export type InviteKind = 'join' | 'claim';

export interface ParsedInvite {
  nonce: string;
  /**
   * `null` when the paste carried no path to tell them apart — a bare code.
   * The caller resolves it by trying the read-only one first.
   */
  kind: InviteKind | null;
}

/** Nonces are 32 random bytes, base64url. Accept a range so a future length works. */
const NONCE = /[A-Za-z0-9_-]{20,}/;

export function parseInvite(input: string): ParsedInvite | null {
  const text = input.trim();
  if (!text) return null;

  // The fragment is the interesting part and never reaches a server, so it
  // survives whatever a chat client did to the rest of the URL.
  const hashAt = text.indexOf('#');
  if (hashAt !== -1) {
    const before = text.slice(0, hashAt);
    const after = text.slice(hashAt + 1);
    // Stop at anything that cannot be part of a nonce: a trailing quote, a
    // full stop, a chat client's invisible padding.
    const found = NONCE.exec(after);
    if (!found) return null;
    return { nonce: found[0], kind: kindOf(before) };
  }

  // No fragment. Either a bare code, or a link whose fragment was stripped —
  // in which case there is nothing to recover and the token in the path is not
  // one.
  if (/[/?]/.test(text)) return null;
  const found = NONCE.exec(text);
  if (!found || found[0] !== text) return null;
  return { nonce: text, kind: null };
}

function kindOf(path: string): InviteKind | null {
  if (/\/join\b/.test(path)) return 'join';
  if (/\/claim\b/.test(path)) return 'claim';
  return null;
}
