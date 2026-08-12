import { useEffect, useState } from 'react';
import { platform } from './platform/index.js';

/**
 * A router in fifty lines.
 *
 * React Router would work, but for five screens it is a dependency (and, at the
 * time of writing, an open advisory) to carry for very little. Routing through
 * `platform.navigation` also keeps the History API out of the components.
 */

export type Route =
  | { name: 'home' }
  | { name: 'claim' }
  | { name: 'join' }
  | { name: 'session'; id: string }
  | { name: 'payments'; id: string }
  | { name: 'history' }
  | { name: 'profile'; id: string }
  | { name: 'admin' };

export function parseRoute(path: string): Route {
  const [pathname] = path.split('?');
  const segments = (pathname ?? '/').split('/').filter(Boolean);

  if (segments.length === 0) return { name: 'home' };

  switch (segments[0]) {
    case 'claim':
      return { name: 'claim' };
    case 'join':
      return { name: 'join' };
    case 'session':
      return segments[1] ? { name: 'session', id: segments[1] } : { name: 'home' };
    case 'payments':
      return segments[1] ? { name: 'payments', id: segments[1] } : { name: 'home' };
    case 'history':
      return { name: 'history' };
    case 'profile':
      return segments[1] ? { name: 'profile', id: segments[1] } : { name: 'home' };
    case 'admin':
      return { name: 'admin' };
    default:
      return { name: 'home' };
  }
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'home':
      return '/';
    case 'claim':
      return '/claim';
    case 'join':
      return '/join';
    case 'session':
      return `/session/${route.id}`;
    case 'payments':
      return `/payments/${route.id}`;
    case 'history':
      return '/history';
    case 'profile':
      return `/profile/${route.id}`;
    case 'admin':
      return '/admin';
  }
}

export function useRoute(): Route {
  const [path, setPath] = useState(() => platform.navigation.path());

  useEffect(() => platform.navigation.subscribe(setPath), []);

  return parseRoute(path);
}

/**
 * Move to another screen.
 *
 * Wrapped in a view transition so the swap cross-fades instead of snapping.
 * The route lives in `useRoute`'s state, so the transition has to enclose the
 * subscriber notification that sets it — which `platform.navigation.push`
 * fires synchronously, and which the seam flushes for us.
 */
export function navigate(route: Route): void {
  platform.viewTransition(() => {
    platform.navigation.push(routePath(route));
    // Arrive at the top of the new screen.
    //
    // Without this you keep whatever scroll offset the last screen had, and
    // the browser merely clamps it to the new page's height — so leaving a
    // long list part-way down drops you into the middle of the next screen
    // for no reason. Inside the transition so the jump is part of the
    // cross-fade rather than a separate lurch after it.
    platform.navigation.scrollToTop();
  });
}

/**
 * Go back to where they actually came from.
 *
 * The header's arrow used to `navigate({ name: 'home' })`, which was wrong
 * twice over: it ignored the route they arrived from, and it *pushed* a new
 * entry, so the browser's own back button then walked forward through the
 * screens they had already dismissed. Stepping the history stack keeps the two
 * back buttons — ours and the browser's — telling the same story.
 *
 * Falls through to home only when there is no in-app history to step into,
 * which is the case that matters most: somebody opening a deep link straight
 * from the group chat has nowhere behind them but the chat itself.
 */
export function goBack(fallback: Route = { name: 'home' }): void {
  if (platform.navigation.canGoBack()) {
    // The transition wraps the *result* of popstate, which arrives
    // asynchronously — so unlike `navigate` there is nothing to flush here.
    platform.navigation.back();
    return;
  }
  navigate(fallback);
}

export function replace(route: Route): void {
  platform.viewTransition(() => platform.navigation.replace(routePath(route)));
}
