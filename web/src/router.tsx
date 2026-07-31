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
  | { name: 'session'; id: string }
  | { name: 'payments'; id: string }
  | { name: 'history' }
  | { name: 'admin' };

export function parseRoute(path: string): Route {
  const [pathname] = path.split('?');
  const segments = (pathname ?? '/').split('/').filter(Boolean);

  if (segments.length === 0) return { name: 'home' };

  switch (segments[0]) {
    case 'claim':
      return { name: 'claim' };
    case 'session':
      return segments[1] ? { name: 'session', id: segments[1] } : { name: 'home' };
    case 'payments':
      return segments[1] ? { name: 'payments', id: segments[1] } : { name: 'home' };
    case 'history':
      return { name: 'history' };
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
    case 'session':
      return `/session/${route.id}`;
    case 'payments':
      return `/payments/${route.id}`;
    case 'history':
      return '/history';
    case 'admin':
      return '/admin';
  }
}

export function useRoute(): Route {
  const [path, setPath] = useState(() => platform.navigation.path());

  useEffect(() => platform.navigation.subscribe(setPath), []);

  return parseRoute(path);
}

export function navigate(route: Route): void {
  platform.navigation.push(routePath(route));
}

export function replace(route: Route): void {
  platform.navigation.replace(routePath(route));
}
