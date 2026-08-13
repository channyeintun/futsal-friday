import { formatKickoff, formatVnd } from '@futsal/shared';
import { useMemo, useState } from 'react';
import { Avatar } from '../components/Avatar.js';
import { ExpandHandle } from '../components/ExpandHandle.js';
import { Icon } from '../components/Icon.js';
import { ProfileCard } from '../components/ProfileCard.js';
import { TeamResult } from '../components/TeamResult.js';
import { VirtualList } from '../components/VirtualList.js';
import { ErrorBanner, Spinner } from '../components/ui.js';
import { useBalancesInfinite, useHistoryInfinite, useProfile } from '../hooks/queries.js';
import { useExpandPin } from '../hooks/useExpandPin.js';
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

  const history = useHistoryInfinite(identity.memberId);
  // Everyone's, not just the organizer's: the point of the list is that being
  // on it is public.
  const balances = useBalancesInfinite(true);

  // Flattened once per fetch: the virtualizer reads these on every scroll frame.
  const played = useMemo(
    () => history.data?.pages.flatMap((page) => page.history) ?? [],
    [history.data],
  );
  const owed = useMemo(
    () => balances.data?.pages.flatMap((page) => page.balances) ?? [],
    [balances.data],
  );
  const profile = useProfile(identity.memberId);

  // Both lists have two sizes: a peek where they sit, and the whole gap
  // between the header and the nav. The heights themselves are in the
  // stylesheet; this is only which of them is in force.
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const [owesExpanded, setOwesExpanded] = useState(false);
  const sessionsRef = useExpandPin<HTMLDivElement>(sessionsExpanded);
  const owesRef = useExpandPin<HTMLDivElement>(owesExpanded);

  /*
   * What this member still owes, for the header that stands in while the
   * profile is in flight.
   *
   * Summed over the pages loaded so far, which is the first twenty Fridays and
   * therefore every debt that realistically exists — but it is an estimate,
   * and it is only ever on screen for the moment before `profile.outstanding`
   * arrives with the figure the server computed over everything.
   */
  const myOutstanding = played.reduce(
    (sum, entry) =>
      entry.payment && entry.payment.status !== 'confirmed' ? sum + entry.payment.amountDue : sum,
    0,
  );

  // Worth offering only when there is something below the fold to reveal. The
  // collapsed card holds about five rows, and a control that visibly does
  // nothing when tapped is worse than no control at all. Kept on while it is
  // expanded regardless, so a list that shrinks under it — somebody pays, the
  // query refetches — cannot strand the screen in the tall state.
  const canExpandOwes = owed.length > 5 || owesExpanded;
  const canExpandSessions = played.length > 5 || history.hasNextPage || sessionsExpanded;

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
                  played.filter((e) => e.registrationStatus === 'in').length,
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

      {/* A season is a hundred Fridays. Paged and virtualized like the debt
          list below it, and for the same two reasons: neither the fetch nor
          the DOM should grow with how long the group has been playing. */}
      {!history.isPending ? (
        <div
          ref={sessionsRef}
          className={`card list-card${sessionsExpanded ? ' is-expanded' : ''}`}
        >
          <h2 className="card-title">{m.history.yourSessions}</h2>
          <VirtualList
            query={history}
            items={played}
            estimateSize={72}
            itemKey={(entry) => entry.session.id}
            empty={<p className="empty">{m.history.nonePlayed}</p>}
            renderItem={(entry) => (
              <button
                type="button"
                className="player-row session-row"
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
                  {/* Only the weeks somebody split the teams — most of the
                      group's history predates the feature, and an empty slot on
                      every other row would be noise for the sake of alignment. */}
                  {entry.teams ? (
                    <TeamResult team={entry.teams.team} outcomes={entry.teams.outcomes} />
                  ) : null}
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
            )}
          />
          {canExpandSessions ? (
            <ExpandHandle
              expanded={sessionsExpanded}
              onToggle={() => setSessionsExpanded((open) => !open)}
            />
          ) : null}
        </div>
      ) : null}

      {/* Shown to everyone, not just the organizer. Being on this list is the
          reminder; that only works if the group can see it. */}
      <div
        ref={owesRef}
        className={`card list-card${owesExpanded ? ' is-expanded' : ''}`}
      >
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
        {canExpandOwes ? (
          <ExpandHandle
            expanded={owesExpanded}
            onToggle={() => setOwesExpanded((open) => !open)}
          />
        ) : null}
      </div>
    </>
  );
}
