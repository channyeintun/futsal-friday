/**
 * The platform seam.
 *
 * Every browser capability the app depends on is declared here and implemented
 * in `web.ts`. Pages and components import from this module and never touch
 * `window`, `document`, `localStorage`, `navigator`, `EventSource` or the Push
 * API directly.
 *
 * The payoff is not hypothetical portability — it is that all the parts with
 * awkward platform behaviour (clipboard in webviews, iOS push only working once
 * installed, image compression, idle detection) live in one file that can be
 * reasoned about and stubbed, instead of being sprinkled through components.
 */

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface Clipboard {
  /** Resolves false when the platform refused rather than throwing. */
  write(text: string): Promise<boolean>;
  /**
   * Resolves null when reading is unavailable or refused — which is common:
   * Safari only allows it from a user gesture, Firefox not at all, and chat
   * webviews frequently block it. Callers must keep a text field as the way
   * that always works.
   */
  read(): Promise<string | null>;
}

/**
 * Cross-fade one screen into the next.
 *
 * A seam because `document.startViewTransition` is browser-only and not
 * universal: the implementation no-ops where it is missing, and — more
 * importantly — where the reader has asked for reduced motion. Callers just
 * hand over the state change and get animation where it is welcome.
 */
export type ViewTransition = (change: () => void) => void;

export interface Navigation {
  /** Current in-app path, e.g. `/session/ses_123`. */
  path(): string;
  /** Jump to the top of the page, without a smooth-scroll animation. */
  scrollToTop(): void;
  /**
   * The URL fragment, without the leading `#`.
   *
   * Claim links carry their secret here rather than in the query string:
   * browsers never send a fragment to the server, so it stays out of access
   * logs, proxy logs and `Referer` headers.
   */
  hash(): string;
  push(path: string): void;
  replace(path: string): void;
  /** True when this app has somewhere of its own to go back to. */
  canGoBack(): boolean;
  /** Step back one entry. Returns false when there was nothing to step to. */
  back(): boolean;
  /** Subscribe to path changes. Returns an unsubscribe function. */
  subscribe(listener: (path: string) => void): () => void;
}

/**
 * A server-sent-events connection.
 *
 * Modelled on just the parts of `EventSource` this app uses, so it could be
 * backed by a WebSocket instead without the caller noticing.
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

/**
 * The noises the app makes.
 *
 * Named for what happened rather than for the files behind them, so a clip can
 * be swapped without a component having to know. `press` is every button in the
 * app, `tapOut` is the one action that takes something away, and `modalOpen` is
 * a panel arriving over the top of everything.
 */
export type SoundName = 'press' | 'tapOut' | 'modalOpen';

/**
 * Button feedback.
 *
 * A capability rather than an `<audio>` tag in a component, on the usual rule
 * and for two reasons of its own.
 *
 * Browsers will not let a page make a noise until somebody has touched it, so
 * *when* the audio hardware may wake up is a platform fact rather than any
 * component's business — and getting it wrong is visible, because the press
 * that wakes it is the press that does not sound. And "every button in the
 * app" is a claim no component can make on its own: it holds because this
 * listens at the document, which is the one place that sees all of them,
 * including the ones inside Material Web's shadow roots and including the
 * button somebody adds next month.
 */
export interface Sound {
  /**
   * Play a clip now. Never throws and never waits: a browser without Web
   * Audio, a clip that failed to load, and a member who turned sound off all
   * come out as silence rather than as an error a caller has to handle.
   *
   * Presses do not come through here — they are declared with `data-sound` and
   * played by the one listener, which is what stops a control sounding twice.
   * This is for the things that are not presses: a dialog opening, and the
   * confirmation the sound switch makes when it is turned back on.
   */
  play(name: SoundName): void;
  /**
   * False where the browser cannot make a noise at all — an old webview, a
   * locked-down browser. Separate from `enabled()`, which is the member's
   * answer rather than the machine's: a settings row that toggles a preference
   * nothing can act on is the thing `notifications.supported()` exists to
   * avoid, and this follows it.
   */
  supported(): boolean;
  /** Whether the member wants a noise, for a settings control. */
  enabled(): boolean;
  setEnabled(on: boolean): void;
}

/** The two things worth feeling: taking a spot, and giving one up. */
export type HapticName = 'in' | 'out';

/**
 * A buzz under the thumb.
 *
 * Only the two presses that change what you have promised the group — taking a
 * spot and giving one up. Everything else in the app makes a noise and nothing
 * else buzzes, because a phone that vibrates on every tap is a phone somebody
 * turns off, and because these two are the ones you want to feel land without
 * looking: standing on a pitch, in the dark, deciding on the way to work.
 *
 * A separate switch from the sound rather than the same one. They are different
 * senses and the reasons to want them differ — a phone already on silent still
 * vibrates by design, which is exactly the case where somebody wants the buzz
 * and not the click.
 */
export interface Haptics {
  /**
   * False wherever the browser cannot vibrate — which today is every iPhone and
   * iPad, since Safari has never implemented this. Checked rather than assumed,
   * so the setting can be hidden instead of offering a switch that does nothing.
   */
  supported(): boolean;
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** Never throws. Silent where unsupported, switched off, or refused. */
  buzz(name: HapticName): void;
}

/** Push notification support, as far as the UI needs to know about it. */
export interface Notifications {
  /** False on browsers without the Push API, and in a non-installed iOS tab. */
  supported(): boolean;
  /**
   * True when the app must be installed to the Home Screen before push will
   * work at all — iOS Safari's rule. The UI shows install instructions instead
   * of a permission button.
   */
  requiresInstall(): boolean;
  permission(): 'default' | 'granted' | 'denied';
  /** Prompts if needed. Resolves the resulting permission. */
  requestPermission(): Promise<'default' | 'granted' | 'denied'>;
  /** Subscribe this device. Returns the raw subscription for the API. */
  subscribe(applicationServerKey: string): Promise<PushSubscriptionJson | null>;
  /** Current subscription, if this device already has one. */
  current(): Promise<PushSubscriptionJson | null>;
  unsubscribe(): Promise<void>;
  /** Fired when the push service rotates a subscription. */
  onSubscriptionChange(listener: () => void): () => void;
}

/** Exactly the shape `PushSubscription.toJSON()` produces. */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Platform {
  storage: KeyValueStorage;
  clipboard: Clipboard;
  navigation: Navigation;
  viewTransition: ViewTransition;
  visibility: Visibility;
  sound: Sound;
  haptics: Haptics;
  notifications: Notifications;
  /**
   * Start listening for presses, once, from the entry point. Returns the
   * teardown that hot reloading needs and nothing else calls.
   *
   * It sits here rather than under `sound` because it is about presses, not
   * about noise: one listener at the document answers every button in the app,
   * in whichever ways are switched on. Controls *declare* what a press means
   * and never reach for `play` or `buzz` themselves — `data-sound="none"` stays
   * quiet, `data-sound="tap-out"` asks for the other clip, and
   * `data-haptic="in" | "out"` asks for a buzz. Declaring rather than calling
   * is what stops a control firing twice: once itself, and once through here.
   *
   * The shared `Button` forwards its `sound` prop as `data-sound`, because
   * React will not pass an unknown attribute to a custom element.
   */
  installPressFeedback(): () => void;
  /** Registers the service worker. Resolves false where unsupported. */
  registerServiceWorker(): Promise<boolean>;
  openExternal(url: string): void;
  openEventStream(url: string, handlers: EventStreamHandlers): EventStream;
  /**
   * Ask the user for a photo. Resolves null if they backed out.
   * A capability rather than an `<input type="file">` in a component, so the
   * hidden-input dance and its cancel handling stay in one place.
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
  /**
   * The device's preferred language tag, e.g. `my-MM`. Used only as the initial
   * guess before the member has chosen one.
   */
  deviceLanguage(): string | null;
  /** Reflects the active language onto the document, for font and hyphenation. */
  setDocumentLanguage(tag: string): void;
  /**
   * Take down the boot splash that `index.html` painted.
   *
   * A capability rather than a `getElementById` in a component, on the usual
   * rule — and the only DOM the app owns that React does not, since the whole
   * point of that element is to be on screen before React has run. Calling it
   * twice is harmless.
   */
  dismissSplash(): void;
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

/** The active platform implementation. */
export const platform: Platform = webPlatform;
