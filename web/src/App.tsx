import type { Identity } from '@futsal/shared';
import { useCallback, useEffect, useState } from 'react';
import { currentIdentity } from './api/auth.js';
import { getToken, onUnauthorized } from './api/client.js';
import { Icon, type IconName } from './components/Icon.js';
import { Spinner } from './components/ui.js';
import { AdminPage } from './pages/AdminPage.js';
import { GatePage } from './pages/GatePage.js';
import { HistoryPage } from './pages/HistoryPage.js';
import { HomePage } from './pages/HomePage.js';
import { PaymentsPage } from './pages/PaymentsPage.js';
import { SessionPage } from './pages/SessionPage.js';
import { type Route, navigate, replace, useRoute } from './router.js';
import { AppProvider, useApp } from './state/app.js';

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
      .then(setIdentity)
      .finally(() => setChecking(false));
  }, []);

  const signOut = useCallback(() => {
    setIdentity(null);
    replace({ name: 'home' });
  }, []);

  if (checking) {
    return (
      <div className="app">
        <Spinner label="Just a moment…" />
      </div>
    );
  }

  if (!identity) return <GatePage onSignedIn={setIdentity} />;

  return (
    <AppProvider identity={identity} onSignOut={signOut}>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { identity, toastMessage } = useApp();

  return (
    <div className="app">
      <header className="topbar">
        {route.name !== 'home' ? (
          <button
            type="button"
            aria-label="Back"
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
          {titleFor(route)}
          <span className="topbar-sub">
            {identity.name}
            {identity.isOrganizer ? ' · organizer' : ''}
          </span>
        </h1>
      </header>

      <main className="content">
        <Page route={route} />
      </main>

      <nav className="bottom-nav">
        <NavButton route={{ name: 'home' }} current={route} icon="ball" label="Session" />
        <NavButton route={{ name: 'history' }} current={route} icon="history" label="History" />
        <NavButton route={{ name: 'admin' }} current={route} icon="tune" label="Setup" />
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
    case 'session':
      return <SessionPage sessionId={route.id} />;
    case 'payments':
      return <PaymentsPage sessionId={route.id} />;
    case 'history':
      return <HistoryPage />;
    case 'admin':
      return <AdminPage />;
  }
}

function titleFor(route: Route): string {
  switch (route.name) {
    case 'home':
      return 'Futsal Friday';
    case 'session':
      return 'Session';
    case 'payments':
      return 'Payments';
    case 'history':
      return 'History';
    case 'admin':
      return 'Setup';
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
