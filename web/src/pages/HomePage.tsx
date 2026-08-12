import { formatKickoff, formatVnd } from '@futsal/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSplashDown } from '../boot.js';
import { Icon } from '../components/Icon.js';
import { VirtualList } from '../components/VirtualList.js';
import { SessionView } from '../components/SessionView.js';
import { ErrorBanner, Spinner } from '../components/ui.js';
import { queryKeys, usePastSessions, useSessions } from '../hooks/queries.js';
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
  const { m, locale, hour12 } = useLocale();
  const queryClient = useQueryClient();
  const overview = useSessions();
  // The history used to be twelve rows bundled into the overview with no way
  // to ask for a thirteenth. It is its own paged query now.
  const past = usePastSessions();
  const playedSessions = useMemo(
    () => past.data?.pages.flatMap((page) => page.sessions) ?? [],
    [past.data],
  );

  const upcomingId = overview.data?.upcoming?.id ?? null;
  const live = useLiveSession(upcomingId, identity.memberId);

  // On a cold launch the boot splash is still up, and this is the screen it is
  // waiting for: a signed-in open costs three requests in a row — the identity,
  // the overview, then the fixture — and ending the splash at any of the first
  // two only trades it for one of the spinners below. Both of those flags are
  // false once their query has settled either way, so an error ends the wait
  // just as an answer does.
  useSplashDown(!overview.isPending && !live.loading);

  // Only when there is genuinely nothing to draw. Coming back to this tab
  // renders the cached fixture at once and refreshes underneath it.
  if (overview.isPending) return <Spinner label={m.home.loading} />;

  return (
    <>
      {overview.error ? <ErrorBanner>{overview.error.message}</ErrorBanner> : null}

      {upcomingId && live.detail ? (
        <SessionView
          detail={live.detail}
          connection={live.connection}
          recentlyChanged={live.recentlyChanged}
          onChanged={() => {
            live.reload();
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
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

      <div className="card">
        <h2 className="card-title">{m.home.previously}</h2>
        {past.error ? <ErrorBanner>{past.error.message}</ErrorBanner> : null}
        {past.isPending ? <Spinner /> : null}
        <VirtualList
          query={past}
          items={playedSessions}
          estimateSize={62}
          itemKey={(session) => session.id}
          empty={<p className="empty">{m.home.noneYet}</p>}
          renderItem={(session) => (
            <button
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
                  {formatKickoff(session.startsAt, locale, hour12)}
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
          )}
        />
      </div>
    </>
  );
}
