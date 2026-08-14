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
 * ## Why the numbers are not on screen until you have voted
 *
 * In a group of twelve, a visible early lead is very hard to vote against: the
 * first two votes decide it and everyone after is ratifying. So the tally is
 * withheld — and withheld by the *server*, not by this component, because a
 * number the client has been sent is a number somebody can read. `Mvp.tally`
 * is simply null until you have picked.
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
  const winners = tally?.filter((entry) => leaders.includes(entry.memberId)) ?? [];

  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">{m.mvp.title}</h2>
        <span className="muted">{m.mvp.turnout(votesCast, voterCount)}</span>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {/*
        The winner, once you have earned the right to see it.

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

      {canVote ? (
        <>
          <p className="muted" style={{ margin: 0 }}>
            {myVote ? m.mvp.changeBody : m.mvp.body}
          </p>

          <ul className="mvp-list">
            {candidates
              // You cannot vote for yourself, so you are not on the ballot.
              // Greying out a row you may never pick is a worse answer than
              // not offering it.
              .filter((candidate) => candidate.memberId !== identity.memberId)
              .map((candidate) => {
                const mine = candidate.memberId === myVote;
                const count = tally?.find((e) => e.memberId === candidate.memberId)?.votes ?? 0;
                return (
                  <li key={candidate.memberId}>
                    <button
                      type="button"
                      className={`mvp-choice${mine ? ' is-mine' : ''}`}
                      aria-pressed={mine}
                      disabled={busy}
                      onClick={() => void vote(mine ? null : candidate.memberId)}
                    >
                      <Avatar
                        memberId={candidate.memberId}
                        name={candidate.memberName}
                        avatarUpdatedAt={candidate.memberAvatarUpdatedAt}
                        size={28}
                      />
                      <span className="mvp-name truncate">{candidate.memberName}</span>
                      {/* Only ever drawn once the server has sent numbers,
                          which it does only once you have voted. */}
                      {tally ? (
                        <span className="mvp-count" aria-label={m.mvp.votes(count)}>
                          {count}
                        </span>
                      ) : null}
                      {mine ? <span className="badge paid">{m.mvp.yours}</span> : null}
                    </button>
                  </li>
                );
              })}
          </ul>

          {myVote ? (
            <Button variant="text" onClick={() => void vote(null)} disabled={busy}>
              {m.mvp.takeItBack}
            </Button>
          ) : (
            <p className="mvp-sealed">{m.mvp.hidden}</p>
          )}
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {m.mvp.playersOnly}
        </p>
      )}
    </div>
  );
}
