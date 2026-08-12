import { formatKickoff, formatVnd } from '@futsal/shared';
import { useMemo } from 'react';
import { Avatar } from '../components/Avatar.js';
import { Icon } from '../components/Icon.js';
import { ProfileCard } from '../components/ProfileCard.js';
import { VirtualList } from '../components/VirtualList.js';
import { ErrorBanner, Spinner } from '../components/ui.js';
import { useBalancesInfinite, useHistory, useProfile } from '../hooks/queries.js';
import { navigate } from '../router.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';

/**
 * Your record: what you played and what you still owe. Organizers additionally
 * get the group-wide ledger, which is the answer to "who still hasn't paid me".
 */
export function HistoryPage() {
  const { identity } = useApp();
  const { m, locale, hour12 } = useLocale();

  const history = useHistory(identity.memberId);
  // Everyone's, not just the organizer's: the point of the list is that being
  // on it is public.
  const balances = useBalancesInfinite(true);
  // Flattened once per fetch: the virtualizer reads this on every scroll frame.
  const owed = useMemo(
    () => balances.data?.pages.flatMap((page) => page.balances) ?? [],
    [balances.data],
  );
  const profile = useProfile(identity.memberId);

  const myOutstanding = (history.data ?? []).reduce(
    (sum, entry) =>
      entry.payment && entry.payment.status !== 'confirmed' ? sum + entry.payment.amountDue : sum,
    0,
  );

  return (
    <>
      {/* Your profile leads: face, streak, and what you owe. Falls back to the
          plain header while the profile is still in flight, so the amount you
          owe never disappears behind a spinner. */}
      {profile.data ? (
        <ProfileCard profile={profile.data} />
      ) : (
        <div className="card">
          <div className="row between">
            <div>
              <h2 className="card-title">{identity.name}</h2>
              <p className="card-sub">
                {m.history.sessionsPlayed(
                  (history.data ?? []).filter((e) => e.registrationStatus === 'in').length,
                )}
              </p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="muted">{m.history.youOwe}</div>
              <div
                className="amount"
                style={{
                  fontSize: '1.3rem',
                  color: myOutstanding > 0 ? 'var(--md-sys-color-error)' : 'var(--ff-paid)',
                }}
              >
                {formatVnd(myOutstanding)}
              </div>
            </div>
          </div>
        </div>
      )}

      {history.error ? <ErrorBanner>{history.error.message}</ErrorBanner> : null}
      {history.isPending ? <Spinner label={m.history.loading} /> : null}

      {history.data && history.data.length > 0 ? (
        <div className="card">
          <h2 className="card-title">{m.history.yourSessions}</h2>
          {history.data.map((entry) => (
            <button
              key={entry.session.id}
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
              onClick={() =>
                navigate(
                  entry.payment
                    ? { name: 'payments', id: entry.session.id }
                    : { name: 'session', id: entry.session.id },
                )
              }
            >
              <span className="grow">
                <span style={{ display: 'block', fontWeight: 500 }}>
                  {formatKickoff(entry.session.startsAt, locale, hour12)}
                </span>
                <span className="muted">
                  {entry.session.venue?.name ?? m.home.noVenue}
                  {entry.registrationStatus === 'waitlist' ? ` · ${m.history.waitlisted}` : ''}
                </span>
              </span>
              {entry.payment ? (
                <>
                  <span className="amount">{formatVnd(entry.payment.amountDue)}</span>
                  <span
                    className={`badge ${
                      entry.payment.status === 'confirmed' ? 'paid' : entry.payment.status
                    }`}
                  >
                    {entry.payment.status === 'confirmed'
                      ? m.payments.statusPaid
                      : entry.payment.status === 'pending'
                        ? m.payments.statusChecking
                        : m.payments.statusUnpaid}
                  </span>
                </>
              ) : null}
            </button>
          ))}
        </div>
      ) : history.data ? (
        <p className="empty">{m.history.nonePlayed}</p>
      ) : null}

      {/* Shown to everyone, not just the organizer. Being on this list is the
          reminder; that only works if the group can see it. */}
      <div className="card">
        <h2 className="card-title">
          <Icon name="money" size={18} /> {m.history.whoOwes}
        </h2>
        <p className="card-sub">{m.history.whoOwesBody}</p>
        {balances.error ? <ErrorBanner>{balances.error.message}</ErrorBanner> : null}
        {balances.isPending ? <Spinner /> : null}
        <VirtualList
          query={balances}
          items={owed}
          estimateSize={60}
          itemKey={(balance) => balance.member.id}
          empty={<p className="empty">{m.history.noPayments}</p>}
          renderItem={(balance) => (
            /* Debtors first, ordered by the server — see `loadMemberBalances`. */
            <div
              className={`player-row${balance.member.id === identity.memberId ? ' is-me' : ''}`}
            >
              <Avatar
                memberId={balance.member.id}
                name={balance.member.name}
                avatarUpdatedAt={balance.member.avatarUpdatedAt}
                size={28}
              />
              <button
                type="button"
                className="player-name truncate grow link"
                onClick={() => navigate({ name: 'profile', id: balance.member.id })}
              >
                {balance.member.name}
              </button>
              <span className="muted" style={{ fontSize: '0.75rem' }}>
                {m.history.sessionsPlayed(balance.sessionsPlayed)}
              </span>
              {balance.outstanding > 0 ? (
                <span className="amount" style={{ color: 'var(--md-sys-color-error)' }}>
                  {formatVnd(balance.outstanding)}
                </span>
              ) : (
                <span className="badge paid">{m.history.settledUp}</span>
              )}
            </div>
          )}
        />
      </div>
    </>
  );
}
