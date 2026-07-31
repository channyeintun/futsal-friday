import { SessionView } from '../components/SessionView.js';
import { ErrorBanner, Spinner } from '../components/ui.js';
import { useLiveSession } from '../hooks/useLiveSession.js';
import { useApp } from '../state/app.js';

/** A specific session, reached from the history list or a shared deep link. */
export function SessionPage({ sessionId }: { sessionId: string }) {
  const { identity } = useApp();
  const live = useLiveSession(sessionId, identity.memberId);

  if (live.loading && !live.detail) return <Spinner label="Loading session…" />;
  if (live.error) return <ErrorBanner>{live.error}</ErrorBanner>;
  if (!live.detail) return <ErrorBanner>That session no longer exists.</ErrorBanner>;

  return (
    <SessionView
      detail={live.detail}
      connection={live.connection}
      recentlyChanged={live.recentlyChanged}
      onChanged={live.reload}
    />
  );
}
