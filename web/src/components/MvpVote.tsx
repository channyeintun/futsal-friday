import type { Mvp } from '@futsal/shared';
import { useState } from 'react';
import { castMvpVote } from '../api/sessions.js';
import { useMvp } from '../hooks/queries.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Avatar } from './Avatar.js';
import { Button, ErrorBanner } from './ui.js';

/**
 * Who was the best today.
 *
 * ## One list, two jobs
 *
 * The standing is on screen for everybody — the reserve who did not play and
 * the member who never signed up read the same numbers as the eleven who were
 * there. Voting is the narrow part: the rows turn into buttons only for
 * somebody who played, and never for their own row, since you cannot vote for
 * yourself.
 *
 * That means a player's own name is in the list without being tappable, which
 * would be a poor ballot but is the right result table — the alternative is
 * the one person who cannot see how many votes they got.
 *
 * ## Anonymous
 *
 * Nothing here can say who voted for whom, because nothing here is ever told.
 * The API returns counts and your own choice; the realtime event carries only
 * the fact that something moved. Small-group inference is not solved by that
 * and cannot be — with four players the second voter can work a lot out — but
 * the app never hands anyone the answer.
 */
export function MvpVote({ sessionId }: { sessionId: string }) {
  const { identity } = useApp();
  const { m } = useLocale();
  const mvp = useMvp(sessionId);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vote = async (nomineeId: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await castMvpVote(sessionId, nomineeId);
      await mvp.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.mvp.failed);
    } finally {
      setBusy(false);
    }
  };

  if (mvp.isPending || !mvp.data) return null;
  const { candidates, myVote, tally, votesCast, voterCount, leaders } = mvp.data;

  // Nobody to vote for. Two players cannot run an award between them without
  // it being one person choosing the other.
  if (candidates.length < 3) return null;

  const canVote = candidates.some((candidate) => candidate.memberId === identity.memberId);
  const winners = tally.filter((entry) => leaders.includes(entry.memberId));

  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">{m.mvp.title}</h2>
        <span className="muted">{m.mvp.turnout(votesCast, voterCount)}</span>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {/*
        The winner, as soon as there is one, to whoever is looking.

        Deliberately the loudest thing on the card — a trophy, the name at
        display size, and the count under it. An award announced in a table row
        is not an award. Several names when it is a tie, because a tiebreak
        nobody agreed to is worse than a shared trophy.
      */}
      {winners.length > 0 ? (
        <div className={`mvp-crown${winners.length > 1 ? ' is-shared' : ''}`}>
          <span className="mvp-trophy" aria-hidden="true">
            🏆
          </span>
          <div className="mvp-winners">
            {winners.map((winner) => (
              <span key={winner.memberId} className="mvp-winner">
                <Avatar
                  memberId={winner.memberId}
                  name={winner.memberName}
                  avatarUpdatedAt={winner.memberAvatarUpdatedAt}
                  size={40}
                />
                <span className="mvp-winner-name truncate">{winner.memberName}</span>
              </span>
            ))}
          </div>
          <span className="mvp-crown-note">
            {winners.length > 1
              ? m.mvp.shared(winners[0]!.votes)
              : m.mvp.leadingWith(winners[0]!.votes)}
          </span>
        </div>
      ) : null}

      <p className="muted" style={{ margin: 0 }}>
        {!canVote ? m.mvp.playersOnly : myVote ? m.mvp.changeBody : m.mvp.body}
      </p>

      {/*
        The standing, in the order it stands: highest first, as the server
        sorted it. Anybody holding votes is here even if they were marked
        absent afterwards, which is why this runs off the tally and not the
        ballot — the two differ exactly in the cases worth showing.
      */}
      <ul className="mvp-list">
        {tally.map((entry) => {
          const mine = entry.memberId === myVote;
          const votable =
            canVote &&
            entry.memberId !== identity.memberId &&
            candidates.some((candidate) => candidate.memberId === entry.memberId);

          const inside = (
            <>
              <Avatar
                memberId={entry.memberId}
                name={entry.memberName}
                avatarUpdatedAt={entry.memberAvatarUpdatedAt}
                size={28}
              />
              <span className="mvp-name truncate">{entry.memberName}</span>
              <span className="mvp-count" aria-label={m.mvp.votes(entry.votes)}>
                {entry.votes}
              </span>
              {mine ? <span className="badge paid">{m.mvp.yours}</span> : null}
            </>
          );

          return (
            <li key={entry.memberId}>
              {votable ? (
                <button
                  type="button"
                  className={`mvp-choice${mine ? ' is-mine' : ''}`}
                  aria-pressed={mine}
                  disabled={busy}
                  onClick={() => void vote(mine ? null : entry.memberId)}
                >
                  {inside}
                </button>
              ) : (
                // Not a disabled button: there is nothing here to enable. A
                // row you may never press should not spend its life looking
                // like a press that failed.
                <div className="mvp-choice is-static">{inside}</div>
              )}
            </li>
          );
        })}
      </ul>

      {myVote ? (
        <Button variant="text" onClick={() => void vote(null)} disabled={busy}>
          {m.mvp.takeItBack}
        </Button>
      ) : null}
    </div>
  );
}
