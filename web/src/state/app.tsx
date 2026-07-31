import type { Identity } from '@futsal/shared';
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import * as authApi from '../api/auth.js';

interface AppValue {
  identity: Identity;
  /** Re-reads the identity, e.g. after the organizer renames someone. */
  refresh(): Promise<void>;
  signOut(): Promise<void>;
  /** Transient message at the bottom of the screen. */
  toast(message: string): void;
  toastMessage: string | null;
}

const AppContext = createContext<AppValue | null>(null);

export function AppProvider({
  identity: initial,
  onSignOut,
  children,
}: {
  identity: Identity;
  onSignOut(): void;
  children: ReactNode;
}) {
  const [identity, setIdentity] = useState(initial);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    // Long enough to read a sentence, short enough not to sit on the nav bar.
    window.setTimeout(() => setToastMessage((current) => (current === message ? null : current)), 3200);
  }, []);

  const refresh = useCallback(async () => {
    const next = await authApi.currentIdentity();
    if (next) setIdentity(next);
  }, []);

  const signOut = useCallback(async () => {
    await authApi.logout();
    onSignOut();
  }, [onSignOut]);

  const value = useMemo<AppValue>(
    () => ({ identity, refresh, signOut, toast, toastMessage }),
    [identity, refresh, signOut, toast, toastMessage],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}
