import { formatKickoff, formatVnd } from '@futsal/shared';
import { listBalances, memberHistory } from '../api/members.js';
import { Icon } from '../components/Icon.js';
import { ErrorBanner, Spinner } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { navigate } from '../router.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';

/**
 * Your record: what you played and what you still owe. Organizers additionally
 * get the group-wide ledger, which is the answer to "who still hasn't paid me".
 */
export function HistoryPage() {
  const { identity } = useApp();
  const { m, locale } = useLocale();

  const history = useAsync(
    (signal) => memberHistory(identity.memberId, signal),
    [identity.memberId],
  );
  const balances = useAsync(
    (signal) => (identity.isOrganizer ? listBalances(signal) : Promise.resolve([])),
    [identity.isOrganizer],
  );

  const myOutstanding = (history.data ?? []).reduce(
    (sum, entry) =>
      entry.payment && entry.payment.status !== 'confirmed' ? sum + entry.payment.amountDue : sum,
    0,
  );

  return (
    <>
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

      {history.error ? <ErrorBanner>{history.error}</ErrorBanner> : null}
      {history.loading && !history.data ? <Spinner label={m.history.loading} /> : null}

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
                  {formatKickoff(entry.session.startsAt, locale)}
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

      {identity.isOrganizer ? (
        <div className="card">
          <h2 className="card-title">
            <Icon name="money" size={18} /> {m.history.whoOwes}
          </h2>
          {balances.error ? <ErrorBanner>{balances.error}</ErrorBanner> : null}
          {(balances.data ?? []).length === 0 ? (
            <p className="empty">{m.history.noPayments}</p>
          ) : (
            (balances.data ?? [])
              // Debtors first — that is the list the organizer is chasing.
              .slice()
              .sort((a, b) => b.outstanding - a.outstanding)
              .map((balance) => (
                <div key={balance.member.id} className="player-row">
                  <span className="player-name truncate">{balance.member.name}</span>
                  <span className="muted">{balance.sessionsPlayed}×</span>
                  <span
                    className="amount"
                    style={{
                      color:
                        balance.outstanding > 0 ? 'var(--md-sys-color-error)' : 'var(--ff-paid)',
                    }}
                  >
                    {formatVnd(balance.outstanding)}
                  </span>
                </div>
              ))
          )}
        </div>
      ) : null}
    </>
  );
}
