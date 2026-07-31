import { formatKickoff, formatVnd } from '@futsal/shared';
import { listSessions } from '../api/sessions.js';
import { Icon } from '../components/Icon.js';
import { SessionView } from '../components/SessionView.js';
import { ErrorBanner, Spinner } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { useLiveSession } from '../hooks/useLiveSession.js';
import { navigate } from '../router.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';

/**
 * Home is the upcoming session — that is what people open the app for. Past
 * sessions sit underneath as a short list, mostly as a way into unpaid ones.
 */
export function HomePage() {
  const { identity } = useApp();
  const { m, locale } = useLocale();
  const overview = useAsync((signal) => listSessions(signal), []);

  const upcomingId = overview.data?.upcoming?.id ?? null;
  const live = useLiveSession(upcomingId, identity.memberId);

  if (overview.loading && !overview.data) return <Spinner label={m.home.loading} />;

  return (
    <>
      {overview.error ? <ErrorBanner>{overview.error}</ErrorBanner> : null}

      {upcomingId && live.detail ? (
        <SessionView
          detail={live.detail}
          connection={live.connection}
          recentlyChanged={live.recentlyChanged}
          onChanged={() => {
            live.reload();
            overview.reload();
          }}
        />
      ) : upcomingId ? (
        <Spinner label={m.session.loading} />
      ) : (
        <div className="card">
          <h2 className="card-title">{m.home.noSession}</h2>
          <p className="card-sub">
            {identity.isOrganizer ? m.home.noSessionOrganizer : m.home.noSessionMember}
          </p>
        </div>
      )}

      {overview.data && overview.data.recent.length > 0 ? (
        <div className="card">
          <h2 className="card-title">{m.home.previously}</h2>
          <div>
            {overview.data.recent.map((session) => (
              <button
                key={session.id}
                type="button"
                className="player-row"
                style={{
                  width: '100%',
                  background: 'none',
                  border: 0,
                  borderBottom: '1px solid var(--md-sys-color-outline-variant)',
                  font: 'inherit',
                  color: 'inherit',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onClick={() => navigate({ name: 'session', id: session.id })}
              >
                <Icon name={session.status === 'cancelled' ? 'close' : 'ball'} size={18} />
                <span className="grow">
                  <span className="truncate" style={{ display: 'block', fontWeight: 500 }}>
                    {formatKickoff(session.startsAt, locale)}
                  </span>
                  <span className="muted">
                    {session.venue?.name ?? m.home.noVenue}
                    {session.totalCharge != null ? ` · ${formatVnd(session.totalCharge)}` : ''}
                  </span>
                </span>
                {session.status === 'cancelled' ? (
                  <span className="badge unpaid">{m.home.badgeCancelled}</span>
                ) : session.totalCharge == null ? (
                  <span className="badge pending">{m.home.badgeNotSplit}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
