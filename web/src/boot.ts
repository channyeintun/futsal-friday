import { useEffect } from 'react';
import { platform } from './platform/index.js';

/**
 * When the boot splash comes down.
 *
 * `index.html` paints a splash before the bundle has run, and it stays up
 * through the mount and the first request or two, so that opening the app is
 * one handover rather than blank page, spinner, screen.
 *
 * The rule is that it goes when the first screen has something real on it —
 * which is a thing only that screen knows, hence a hook the screens call rather
 * than a flag `App` works out on their behalf. Ending it at "the identity is
 * known" instead would have handed the splash straight over to `HomePage`'s own
 * spinner, which is the screen this was asked to replace.
 *
 * Latched at module scope, not per component: several screens may report, in
 * any order, and the first one wins. Strict mode's double-invoked effects fall
 * out of the same latch for free.
 */
let down = false;

/**
 * The outside limit.
 *
 * Not every route reports — a link straight into a session, a screen reached
 * from a bookmark, a query that never settles — and a splash that stays is
 * worse than any spinner, because it looks like an app that is still working.
 * Comfortably past the three requests a cold signed-in launch makes on a phone,
 * and short enough that a stalled one drops back to the app's own progress
 * while the reader is still expecting something to happen.
 */
export const SPLASH_CAP_MS = 2500;

/** Take the splash down now, whatever is behind it. */
export function splashDown(): void {
  if (down) return;
  down = true;
  platform.dismissSplash();
}

/** Take it down on the first render where `ready` is true. */
export function useSplashDown(ready: boolean): void {
  useEffect(() => {
    if (ready) splashDown();
  }, [ready]);
}
