import {
  DEFAULT_LOCALE,
  type Locale,
  type Messages,
  isLocale,
  messagesFor,
  normalizeLocale,
} from '@futsal/shared';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { updateNotificationPrefs } from '../api/push.js';
import { platform } from '../platform/index.js';

/**
 * Active language.
 *
 * Resolved in this order:
 *
 *   1. **An explicit choice on this device.** Always wins, and applies before
 *      any network request.
 *   2. **The device's own language, when it is not English.** A phone set to
 *      Burmese opens in Burmese.
 *   3. **The member's stored choice**, so switching to Burmese on a phone
 *      carries over to a laptop whose system language is English.
 *   4. English.
 *
 * Step 2 sits above step 3 deliberately. `members.language` defaults to `'en'`
 * for a row the organizer created before that person ever opened the app, so
 * the server cannot distinguish "chose English" from "never chose". Letting
 * that default outrank device detection meant a Burmese phone opened in
 * English — which defeats the point of detecting at all.
 *
 * The choice is also pushed to the server, because push notification text is
 * written there: the browser that picked the language is asleep when the
 * reminder goes out.
 */

interface LocaleValue {
  locale: Locale;
  m: Messages;
  setLocale(next: Locale): void;
  /** True for "7:30 PM", false for "19:30". */
  hour12: boolean;
  setHour12(next: boolean): void;
}

const LocaleContext = createContext<LocaleValue | null>(null);

const STORAGE_KEY = 'locale';
const HOUR12_KEY = 'hour12';

function initialLocale(): Locale {
  const stored = platform.storage.get(STORAGE_KEY);
  if (isLocale(stored)) return stored;
  return normalizeLocale(platform.deviceLanguage());
}

/** True when the device itself asked for a non-default language. */
function deviceAsksForNonDefault(): boolean {
  return normalizeLocale(platform.deviceLanguage()) !== DEFAULT_LOCALE;
}

export function LocaleProvider({
  children,
  /** The member's stored preference, once known. Overrides the device guess. */
  serverLocale,
  /** Likewise their clock. Undefined until the first fetch answers. */
  serverHour12,
}: {
  children: ReactNode;
  serverLocale?: Locale | null;
  serverHour12?: boolean | null;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [hour12, setHour12State] = useState<boolean>(
    () => platform.storage.get(HOUR12_KEY) === '1',
  );

  useEffect(() => {
    if (!serverLocale) return;
    // An explicit choice on this device outranks the server, or a member who
    // just switched would be reverted by the next fetch.
    if (platform.storage.get(STORAGE_KEY)) return;
    // A device asking for a non-default language outranks the server's value,
    // which may only be the column default rather than a real preference.
    if (deviceAsksForNonDefault()) return;
    setLocaleState(serverLocale);
  }, [serverLocale]);

  useEffect(() => {
    if (serverHour12 == null) return;
    // Same rule as the language: a choice made on this device wins, or the
    // next fetch would undo it.
    if (platform.storage.get(HOUR12_KEY)) return;
    setHour12State(serverHour12);
  }, [serverHour12]);

  useEffect(() => {
    platform.setDocumentLanguage(locale === 'my' ? 'my' : 'en');
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    platform.storage.set(STORAGE_KEY, next);
    // Best-effort: the UI has already switched, and a failure here only means
    // notifications arrive in the previous language.
    void updateNotificationPrefs({ language: next }).catch(() => {});
  }, []);

  const setHour12 = useCallback((next: boolean) => {
    setHour12State(next);
    platform.storage.set(HOUR12_KEY, next ? '1' : '0');
    // Best-effort, exactly as for the language: the screen has already
    // changed, and a failure only means push reminders keep the old clock.
    void updateNotificationPrefs({ hour12: next }).catch(() => {});
  }, []);

  const value = useMemo<LocaleValue>(
    () => ({ locale, m: messagesFor(locale), setLocale, hour12, setHour12 }),
    [locale, setLocale, hour12, setHour12],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
  const value = useContext(LocaleContext);
  // The gate screen renders outside any provider, so fall back rather than
  // throwing — an untranslated sign-in beats a blank page.
  if (!value) {
    const locale = initialLocale();
    return {
      locale,
      m: messagesFor(locale),
      setLocale: () => {},
      hour12: platform.storage.get(HOUR12_KEY) === '1',
      setHour12: () => {},
    };
  }
  return value;
}

/** Shorthand for the common case of only needing the strings. */
export function useMessages(): Messages {
  return useLocale().m;
}

export { DEFAULT_LOCALE };
