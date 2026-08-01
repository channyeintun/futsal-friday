import type { Identity } from '@futsal/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { currentIdentity } from './api/auth.js';
import { getToken, onUnauthorized } from './api/client.js';
import { Icon, type IconName } from './components/Icon.js';
import { Spinner } from './components/ui.js';
import { AdminPage } from './pages/AdminPage.js';
import { ClaimPage, SignInNeeded } from './pages/ClaimPage.js';
import { JoinPage } from './pages/JoinPage.js';
import { HistoryPage } from './pages/HistoryPage.js';
import { HomePage } from './pages/HomePage.js';
import { PaymentsPage } from './pages/PaymentsPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { SessionPage } from './pages/SessionPage.js';
import { WaitingPage } from './pages/WaitingPage.js';
import { platform } from './platform/index.js';
import { type Route, navigate, parseRoute, replace, useRoute } from './router.js';
import { AppProvider, useApp } from './state/app.js';
import { LocaleProvider, useMessages } from './state/locale.js';

/**
 * One client for the whole app. Only the cached reads go through it — see
 * `hooks/queries.ts` — so its defaults are tuned for those: a phone that has
 * been in a pocket should not fire a burst of refetches the moment it wakes.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  // With no stored token there is nothing to validate, so show the invite
  // screen immediately instead of parking a first-time visitor on a spinner
  // while a request that is certain to 401 goes out and comes back. The check
  // still runs underneath, which recovers the rarer case of a live auth cookie
  // with no token beside it (same-origin deploys, cleared local storage).
  const [checking, setChecking] = useState(() => getToken() !== null);

  useEffect(() => {
    // A rejected token can surface from any request; drop straight back to the
    // gate rather than leaving the user on a screen that cannot load.
    onUnauthorized(() => setIdentity(null));

    currentIdentity()
      // Only ever *establish* an identity, never clear one. This probe is
      // fired before any credential exists, so on a claim link it races the
      // sign-in and resolves null a moment after the claim succeeded —
      // assigning that null would bounce the user back to the sign-in screen
      // having just signed in.
      .then((found) => setIdentity((current) => current ?? found))
      .finally(() => setChecking(false));
  }, []);

  const signOut = useCallback(() => {
    setIdentity(null);
    replace({ name: 'home' });
  }, []);

  if (checking) {
    return (
      <LocaleProvider>
        <Booting />
      </LocaleProvider>
    );
  }

  if (!identity) {
    // Two ways in: /join is the one link the whole group gets, /claim is a
    // personal link. Anywhere else just explains that you need one.
    const route = parseRoute(platform.navigation.path()).name;
    return (
      <LocaleProvider>
        {route === 'join' ? (
          <JoinPage onSignedIn={setIdentity} />
        ) : route === 'claim' ? (
          <ClaimPage onSignedIn={setIdentity} />
        ) : (
          <SignInNeeded />
        )}
      </LocaleProvider>
    );
  }

  // Added themselves from the group link and not let in yet. The server
  // refuses everything but `/auth/me`, so there is no app to show them —
  // and nothing about the group should be shown to somebody who might have
  // been forwarded the link from outside it.
  if (!identity.approved) {
    return (
      <LocaleProvider serverLocale={identity.language}>
        <WaitingPage identity={identity} onApproved={setIdentity} />
      </LocaleProvider>
    );
  }

  return (
    // The member's stored language seeds the provider, but only when this
    // device has not already chosen one for itself.
    <LocaleProvider serverLocale={identity.language}>
      <QueryClientProvider client={queryClient}>
        <AppProvider identity={identity} onSignOut={signOut}>
          <Shell />
        </AppProvider>
      </QueryClientProvider>
    </LocaleProvider>
  );
}

function Booting() {
  const m = useMessages();
  return (
    <div className="app">
      <Spinner label={m.app.loading} />
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const { identity, toastMessage } = useApp();
  const m = useMessages();

  return (
    <div className="app">
      <header className="topbar">
        {route.name !== 'home' ? (
          <button
            type="button"
            aria-label={m.app.back}
            onClick={() => navigate({ name: 'home' })}
            style={{
              background: 'none',
              border: 0,
              color: 'inherit',
              cursor: 'pointer',
              padding: 4,
              display: 'flex',
            }}
          >
            <Icon name="back" />
          </button>
        ) : (
          <Icon name="ball" size={26} />
        )}
        <h1>
          {titleFor(route, m)}
          <span className="topbar-sub">
            {identity.name}
            {identity.isOrganizer ? ` · ${m.app.organizerSuffix}` : ''}
          </span>
        </h1>
      </header>

      <main className="content">
        <Page route={route} />
      </main>

      <nav className="bottom-nav">
        <NavButton route={{ name: 'home' }} current={route} icon="ball" label={m.nav.session} />
        <NavButton route={{ name: 'history' }} current={route} icon="history" label={m.nav.history} />
        <NavButton route={{ name: 'admin' }} current={route} icon="tune" label={m.nav.setup} />
      </nav>

      {toastMessage ? (
        <div className="snackbar" role="status">
          {toastMessage}
        </div>
      ) : null}
    </div>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HomePage />;
    // Reached only when an already-signed-in device opens a link; the shell is
    // already up, so just show them the app.
    case 'claim':
    case 'join':
      return <HomePage />;
    case 'session':
      return <SessionPage sessionId={route.id} />;
    case 'payments':
      return <PaymentsPage sessionId={route.id} />;
    case 'history':
      return <HistoryPage />;
    case 'profile':
      return <ProfilePage memberId={route.id} />;
    case 'admin':
      return <AdminPage />;
  }
}

function titleFor(route: Route, m: ReturnType<typeof useMessages>): string {
  switch (route.name) {
    case 'home':
    case 'claim':
    case 'join':
      return m.app.name;
    case 'session':
      return m.nav.sessionTitle;
    case 'payments':
      return m.nav.payments;
    case 'history':
      return m.nav.history;
    case 'profile':
      return m.profile.title;
    case 'admin':
      return m.nav.setup;
  }
}

function NavButton({
  route,
  current,
  icon,
  label,
}: {
  route: Route;
  current: Route;
  icon: IconName;
  label: string;
}) {
  // Session and payment screens are reached from home, so keep that tab lit.
  const active =
    route.name === current.name ||
    (route.name === 'home' && (current.name === 'session' || current.name === 'payments'));

  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => navigate(route)}
    >
      <Icon name={icon} size={22} />
      {label}
    </button>
  );
}
