import { formatKickoff, formatVnd } from '@futsal/shared';
import { Icon } from '../components/Icon.js';
import { ProfileCard } from '../components/ProfileCard.js';
import { ErrorBanner, Spinner } from '../components/ui.js';
import { useBalances, useHistory, useProfile } from '../hooks/queries.js';
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
  const balances = useBalances(true);
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
        {(balances.data ?? []).length === 0 ? (
          <p className="empty">{m.history.noPayments}</p>
        ) : (
          (balances.data ?? [])
            // Debtors first. It is the list nobody wants to be at the top of,
            // which only works if the top is where the eye lands.
            .slice()
            .sort((a, b) => b.outstanding - a.outstanding)
            .map((balance) => (
              <div
                key={balance.member.id}
                className={`player-row${balance.member.id === identity.memberId ? ' is-me' : ''}`}
              >
                <span className="player-name truncate">{balance.member.name}</span>
                <span className="muted">{balance.sessionsPlayed}×</span>
                <span
                  className="amount"
                  style={{
                    color:
                      balance.outstanding > 0 ? 'var(--md-sys-color-error)' : 'var(--ff-paid)',
                  }}
                >
                  {balance.outstanding > 0 ? formatVnd(balance.outstanding) : m.history.settledUp}
                </span>
              </div>
            ))
        )}
      </div>
    </>
  );
}
