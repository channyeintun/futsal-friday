import type {
  CompressOptions,
  CompressedImage,
  EventStream,
  EventStreamHandlers,
  Platform,
  PushSubscriptionJson,
} from './index.js';
import { flushSync } from 'react-dom';

/**
 * Browser implementation of the platform seam. This is the only file in the
 * frontend allowed to reference `window`, `document`, `localStorage`,
 * `navigator` or `EventSource`.
 */

const STORAGE_PREFIX = 'futsal:';

const storage: Platform['storage'] = {
  get(key) {
    try {
      return localStorage.getItem(STORAGE_PREFIX + key);
    } catch {
      // Private browsing modes throw rather than degrade. Treat as empty.
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch {
      /* nothing we can do; the session simply will not persist */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(STORAGE_PREFIX + key);
    } catch {
      /* ignore */
    }
  },
};

const clipboard: Platform['clipboard'] = {
  async write(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Falls through to the legacy path — chat webviews often block the
      // async clipboard API but still allow execCommand.
    }
    return legacyCopy(text);
  },

  async read() {
    try {
      if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
    } catch {
      // Denied, or no permission prompt available. There is no legacy fallback
      // for reading — `execCommand('paste')` was never allowed — so the caller
      // falls back to letting the user paste into a field themselves.
    }
    return null;
  },
};

/** `document.execCommand` is deprecated but is the only path in some webviews. */
function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- navigation */

const listeners = new Set<(path: string) => void>();

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

function notify() {
  const path = currentPath();
  for (const listener of listeners) listener(path);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notify);
  // A URL that differs only in its fragment is a same-document navigation:
  // no reload, no popstate. Claim links live in the fragment, so without this
  // opening a second one in an already-open tab would appear to do nothing.
  window.addEventListener('hashchange', notify);
}

/**
 * Run a state change inside a view transition.
 *
 * `flushSync` is the load-bearing part: `startViewTransition` snapshots the
 * DOM, calls this back, then snapshots again — so React has to have rendered
 * by the time the callback returns. React's own scheduling would otherwise
 * paint after the transition had already given up, and the animation would
 * cross-fade a screen into itself.
 */
interface ViewTransitionHandle {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
}

const viewTransition: Platform['viewTransition'] = (change) => {
  const start = (
    document as Document & {
      startViewTransition?: (cb: () => void) => ViewTransitionHandle;
    }
  ).startViewTransition;

  // Motion is a preference, not a default. Anyone who has asked for less of it
  // gets the same navigation without the cross-fade.
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  if (typeof start !== 'function' || reduced) {
    change();
    return;
  }

  const transition = start.call(document, () => {
    flushSync(change);
  });

  // A transition that is superseded — two taps in quick succession, or a
  // backgrounded tab — rejects these with `AbortError`. Nothing is wrong and
  // there is nothing to do, but an unhandled rejection would show up in the
  // console and in any error reporting attached to it.
  transition.finished.catch(() => {});
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
};

/**
 * How many entries this app has pushed onto the history stack.
 *
 * `history.length` cannot answer "can I go back *within the app*" — it counts
 * everything the tab has ever visited, including whatever page the user was on
 * before they opened the invite link. Going back from the first screen would
 * then leave the app entirely. Counting our own pushes is the only reliable
 * way to know there is somewhere of ours to return to.
 *
 * A `popstate` decrements it, so walking back down the stack eventually
 * reaches zero and the back button starts falling through to home instead.
 */
let ownDepth = 0;

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    ownDepth = Math.max(0, ownDepth - 1);
  });
}

const navigation: Platform['navigation'] = {
  path: currentPath,
  // `instant`, not smooth: this runs inside a view transition, and a
  // smooth-scroll would still be travelling after the cross-fade had finished.
  scrollToTop: () => window.scrollTo({ top: 0, behavior: 'instant' }),
  hash: () => window.location.hash.replace(/^#/, ''),
  canGoBack: () => ownDepth > 0,
  back() {
    if (ownDepth === 0) return false;
    // `history.back()` is asynchronous and fires `popstate`, which the counter
    // above and the path subscribers both listen for — so nothing needs to be
    // notified here.
    window.history.back();
    return true;
  },
  push(path) {
    window.history.pushState({}, '', path);
    ownDepth += 1;
    notify();
  },
  replace(path) {
    window.history.replaceState({}, '', path);
    notify();
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/* -------------------------------------------------------------- visibility */

const visibility: Platform['visibility'] = {
  isVisible() {
    return document.visibilityState === 'visible';
  },
  subscribe(listener) {
    const handler = () => listener(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
  onInteraction(listener) {
    const events = ['pointerdown', 'keydown', 'focus'] as const;
    for (const event of events) {
      window.addEventListener(event, listener, { passive: true });
    }
    return () => {
      for (const event of events) window.removeEventListener(event, listener);
    };
  },
};

/* ------------------------------------------------------------ event stream */

function openEventStream(url: string, handlers: EventStreamHandlers): EventStream {
  // `withCredentials` is deliberately off: the stream authenticates with a
  // short-lived ticket in the query string, so the server can keep its
  // permissive CORS header and this works cross-origin on every browser.
  const source = new EventSource(url);

  source.onopen = () => handlers.onOpen();
  source.onmessage = (event: MessageEvent<string>) => handlers.onMessage(event.data);
  source.onerror = () => handlers.onError();

  return {
    close() {
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      source.close();
    },
  };
}

/* -------------------------------------------------------------- language */

function deviceLanguage(): string | null {
  return navigator.languages?.[0] ?? navigator.language ?? null;
}

/**
 * `<html lang>` is not cosmetic here: it is what tells the browser to pick a
 * Myanmar font for Burmese text and to line-break a script that has no spaces
 * between words.
 */
function setDocumentLanguage(tag: string): void {
  document.documentElement.lang = tag;
}

/* ----------------------------------------------------------- notifications */

/**
 * Standalone means "launched from the Home Screen" rather than in a tab.
 * `display-mode: standalone` covers Android and desktop; `navigator.standalone`
 * is the old iOS-only flag, which is still the reliable signal there.
 */
function isInstalled(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  // iPadOS reports as Mac, so the touch-point check is what catches it.
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

const notifications: Platform['notifications'] = {
  supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  },

  requiresInstall() {
    // iOS 16.4+ only delivers Web Push to a Home Screen install — in a plain
    // Safari tab the APIs may not even be defined.
    return isIos() && !isInstalled();
  },

  permission() {
    if (!('Notification' in window)) return 'denied';
    return Notification.permission as 'default' | 'granted' | 'denied';
  },

  async requestPermission() {
    if (!('Notification' in window)) return 'denied';
    return (await Notification.requestPermission()) as 'default' | 'granted' | 'denied';
  },

  async subscribe(applicationServerKey) {
    const registration = await navigator.serviceWorker.ready;

    // Reuse an existing subscription rather than creating a second one for the
    // same device; `applicationServerKey` cannot be changed on an existing sub.
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing.toJSON() as PushSubscriptionJson;

    const subscription = await registration.pushManager.subscribe({
      // Required to be true: silent push is not permitted on the open web.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(applicationServerKey) as BufferSource,
    });
    return subscription.toJSON() as PushSubscriptionJson;
  },

  async current() {
    if (!('serviceWorker' in navigator)) return null;
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    return subscription ? (subscription.toJSON() as PushSubscriptionJson) : null;
  },

  async unsubscribe() {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  },

  onSubscriptionChange(listener) {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'push-subscription-change') listener();
    };
    navigator.serviceWorker?.addEventListener('message', handler);
    return () => navigator.serviceWorker?.removeEventListener('message', handler);
  },
};

/** `applicationServerKey` must be raw bytes, not the base64url string. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function registerServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return true;
  } catch (error) {
    console.warn('Service worker registration failed', error);
    return false;
  }
}

/* ---------------------------------------------------------- image handling */

/**
 * A hidden `<input type="file">`, driven imperatively.
 *
 * `cancel` is not universally supported, so the promise also settles when the
 * window regains focus without a file having been chosen — otherwise backing
 * out of the picker would leave the caller waiting forever.
 */
function pickImage(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (result: Blob | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(result);
    };

    const onFocus = () => {
      // Fires before `change` in some browsers; give the file a moment to land.
      window.setTimeout(() => finish(input.files?.[0] ?? null), 500);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    window.addEventListener('focus', onFocus, { once: true });

    input.click();
  });
}

/**
 * Resize and re-encode a screenshot in the browser.
 *
 * A phone screenshot is typically 2-4 MB; R2's free tier is 10 GB and a Worker
 * has no image library, so the shrinking has to happen here. Targets ~150 KB by
 * capping the long edge and then stepping quality down until the blob fits.
 */
async function compressImage(
  file: Blob,
  options: CompressOptions = {},
): Promise<CompressedImage> {
  const maxDimension = options.maxDimension ?? 1280;
  const targetBytes = options.targetBytes ?? 150_000;
  let quality = options.quality ?? 0.82;

  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.drawImage(bitmap, 0, 0, width, height);

    // Transfer screenshots are photos of text; JPEG at moderate quality keeps
    // them legible at a fraction of a PNG's size.
    const contentType = 'image/jpeg';
    let blob = await toBlob(canvas, contentType, quality);

    // Three attempts is enough to get an over-sized image under the target
    // without spending seconds on a phone CPU.
    for (let attempt = 0; attempt < 3 && blob.size > targetBytes; attempt++) {
      quality = Math.max(0.4, quality - 0.15);
      blob = await toBlob(canvas, contentType, quality);
    }

    return { blob, contentType, width, height };
  } finally {
    bitmap.close();
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))),
      type,
      quality,
    );
  });
}

/* -------------------------------------------------------------------- env */

/**
 * `VITE_API_URL` is baked in at build time. Left unset, requests go to `/api`,
 * which the dev server proxies to `wrangler dev` — same-origin, so no CORS and
 * no cookie trouble while developing.
 */
const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api';

const appUrl =
  (import.meta.env.VITE_APP_URL as string | undefined) ??
  (typeof window === 'undefined' ? '' : window.location.origin);

export const webPlatform: Platform = {
  storage,
  clipboard,
  navigation,
  viewTransition,
  visibility,
  openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  notifications,
  registerServiceWorker,
  deviceLanguage,
  setDocumentLanguage,
  openEventStream,
  pickImage,
  compressImage,
  objectUrl: {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
  apiBaseUrl,
  appUrl,
};
