import type { Identity, InviteKind } from '@futsal/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { currentIdentity } from './api/auth.js';
import { getToken, onUnauthorized } from './api/client.js';
import { SPLASH_CAP_MS, splashDown, useSplashDown } from './boot.js';
import { Icon, type IconName } from './components/Icon.js';
import { AdminPage } from './pages/AdminPage.js';
import { PlayersPage } from './pages/PlayersPage.js';
import { ClaimPage, SignInNeeded } from './pages/ClaimPage.js';
import { JoinPage } from './pages/JoinPage.js';
import { HistoryPage } from './pages/HistoryPage.js';
import { HomePage } from './pages/HomePage.js';
import { PaymentsPage } from './pages/PaymentsPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { SessionPage } from './pages/SessionPage.js';
import { WaitingPage } from './pages/WaitingPage.js';
import { platform } from './platform/index.js';
import { type Route, navigate, parseRoute, replace, useRoute, goBack } from './router.js';
import { AppProvider, useApp } from './state/app.js';
import { LocaleProvider, useMessages } from './state/locale.js';

/**
 * One client for the whole app; every read goes through it.
 *
 * The defaults exist to answer one complaint: switching tabs used to show a
 * spinner every time. That needs the cache to outlive the component, which
 * `gcTime` controls, and it needs screens to render cached data while any
 * refresh happens underneath — which is what `isPending` vs `isFetching` is
 * for at the call sites.
 *
 * `refetchOnWindowFocus` stays off deliberately. A phone coming out of a
 * pocket would otherwise fire a burst of requests across every mounted query,
 * and the realtime stream already corrects anything that matters faster than a
 * refetch would.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Long enough to survive wandering around the app; the point of the
      // whole exercise is that coming back to a tab shows what was there.
      gcTime: 30 * 60_000,
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
  // An invite the user pasted, for the case where there is no address bar to
  // open one in. Held here rather than pushed into the URL because
  // `replaceState` fires no event, so writing the hash would not re-route.
  const [pastedInvite, setPastedInvite] = useState<{ kind: InviteKind; nonce: string } | null>(
    null,
  );

  useEffect(() => {
    // A rejected token can surface from any request; drop straight back to the
    // gate rather than leaving the user on a screen that cannot load.
    onUnauthorized(() => setIdentity(null));

    const cap = setTimeout(splashDown, SPLASH_CAP_MS);

    currentIdentity()
      // Only ever *establish* an identity, never clear one. This probe is
      // fired before any credential exists, so on a claim link it races the
      // sign-in and resolves null a moment after the claim succeeded —
      // assigning that null would bounce the user back to the sign-in screen
      // having just signed in.
      .then((found) => setIdentity((current) => current ?? found))
      .finally(() => setChecking(false));

    return () => clearTimeout(cap);
  }, []);

  // The splash goes as soon as the first screen has something on it. Every
  // screen but the shell is its own content the moment it commits — the gate,
  // the two invite flows, the waiting room — so they are settled from here.
  // The shell is the exception: `HomePage` opens on a spinner of its own until
  // the fixture arrives, so it reports for itself once it has one.
  useSplashDown(!checking && (identity === null || !identity.approved));

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
    // personal link. A pasted link takes precedence over the address — an
    // installed PWA has no address bar, so pasting is the only route it has.
    // A bare /join or /claim with no fragment is a dead end — usually a PWA
    // launched from the home screen, where the link that was tapped never
    // reached this window. Send it to the screen that can accept a paste
    // rather than to an error about a link that is not there.
    const onRoute = parseRoute(platform.navigation.path()).name;
    const hasHash = platform.navigation.hash() !== '';
    const route =
      pastedInvite?.kind ?? (hasHash && (onRoute === 'join' || onRoute === 'claim') ? onRoute : '');
    return (
      <LocaleProvider>
        {route === 'join' ? (
          <JoinPage onSignedIn={setIdentity} nonce={pastedInvite?.nonce} />
        ) : route === 'claim' ? (
          <ClaimPage onSignedIn={setIdentity} nonce={pastedInvite?.nonce} />
        ) : (
          <SignInNeeded onInvite={(kind, nonce) => setPastedInvite({ kind, nonce })} />
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

/**
 * Nothing to look at, on purpose: the splash has covered the viewport since the
 * document parsed, so anything drawn here could only ever be seen as a flicker
 * on its way out.
 *
 * It is not nothing to *hear*, though. The splash is decoration and hidden from
 * assistive technology, and a reader who landed on an empty document would be
 * told less than the spinner used to tell them. This is also the first point at
 * which the catalogue exists, so it can say it in one language — which is the
 * thing the inline HTML could not do.
 */
function Booting() {
  const m = useMessages();
  return (
    <p className="sr-only" role="status">
      {m.app.loading}
    </p>
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
            className="icon-button"
            aria-label={m.app.back}
            onClick={() => goBack()}
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
    case 'players':
      return <PlayersPage />;
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
    case 'players':
      return m.nav.players;
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
