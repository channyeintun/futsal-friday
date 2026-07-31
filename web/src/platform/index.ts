/**
 * The platform seam.
 *
 * Everything the browser provides and the Zalo Mini App runtime does not — or
 * spells differently — is declared here and implemented in `web.ts`. Pages and
 * components import from this module and never touch `window`, `document`,
 * `localStorage`, `navigator` or `EventSource` directly.
 *
 * Porting to ZMP then means writing a second implementation of `Platform`:
 * `zmp-sdk` supplies `setStorage`/`getStorage` for `storage`, `setClipboardData`
 * for `clipboard`, and its own router for `navigation`. The UI does not change.
 */

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface Clipboard {
  /** Resolves false when the platform refused rather than throwing. */
  write(text: string): Promise<boolean>;
}

export interface Navigation {
  /** Current in-app path, e.g. `/session/ses_123`. */
  path(): string;
  push(path: string): void;
  replace(path: string): void;
  /** Subscribe to path changes. Returns an unsubscribe function. */
  subscribe(listener: (path: string) => void): () => void;
}

/**
 * A server-sent-events connection.
 *
 * Modelled on the parts of `EventSource` this app uses, so that the ZMP port
 * can back it with polling or a WebSocket without the caller noticing.
 */
export interface EventStream {
  close(): void;
}

export interface EventStreamHandlers {
  onMessage(data: string): void;
  onError(): void;
  onOpen(): void;
}

/** Signals that let the client hang up an idle stream — the Upstash budget. */
export interface Visibility {
  /** False when the app is backgrounded. */
  isVisible(): boolean;
  subscribe(listener: (visible: boolean) => void): () => void;
  /** Fires on any user interaction; used to reset the idle timer. */
  onInteraction(listener: () => void): () => void;
}

export interface Platform {
  storage: KeyValueStorage;
  clipboard: Clipboard;
  navigation: Navigation;
  visibility: Visibility;
  openExternal(url: string): void;
  openEventStream(url: string, handlers: EventStreamHandlers): EventStream;
  /**
   * Ask the user for a photo. Resolves null if they backed out.
   * ZMP supplies its own picker (`chooseImage`), which is exactly why this is
   * a platform capability rather than an `<input type="file">` in a component.
   */
  pickImage(): Promise<Blob | null>;
  /** Resize + re-encode an image before upload. */
  compressImage(file: Blob, options?: CompressOptions): Promise<CompressedImage>;
  /**
   * Turn a downloaded blob into something an `<img src>` can point at.
   * Payment screenshots need an auth header, so they are fetched as blobs
   * rather than linked directly.
   */
  objectUrl: {
    create(blob: Blob): string;
    revoke(url: string): void;
  };
  /** Base URL of the API. */
  apiBaseUrl: string;
  /** Public URL of this app, embedded in shareable summaries. */
  appUrl: string;
}

export interface CompressOptions {
  maxDimension?: number;
  /** JPEG/WebP quality, 0-1. */
  quality?: number;
  /** Give up shrinking below this and accept the result. */
  targetBytes?: number;
}

export interface CompressedImage {
  blob: Blob;
  contentType: string;
  width: number;
  height: number;
}

import { webPlatform } from './web.js';

/**
 * The active platform. A ZMP build swaps this for `zmpPlatform` and nothing
 * else in the app changes.
 */
export const platform: Platform = webPlatform;
