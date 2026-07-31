import type {
  CompressOptions,
  CompressedImage,
  EventStream,
  EventStreamHandlers,
  Platform,
} from './index.js';

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
}

const navigation: Platform['navigation'] = {
  path: currentPath,
  push(path) {
    window.history.pushState({}, '', path);
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
  visibility,
  openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
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
