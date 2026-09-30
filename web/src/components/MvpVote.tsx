import type { MvpTallyEntry } from '@futsal/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { castMvpVote } from '../api/sessions.js';
import { queryKeys, useMvp } from '../hooks/queries.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Avatar } from './Avatar.js';
import { Icon } from './Icon.js';
import { ItemCard } from './ItemCard.js';
import { Button, ErrorBanner } from './ui.js';

/**
 * Who was the best today.
 *
 * ## A ballot, and then a result
 *
 * The two used to be one list, sorted by votes, with the rows turning into
 * buttons for the people who played. Nobody voted. The list re-sorted under
 * your thumb every time somebody else did, a second tap quietly took your vote
 * back, and — the one that actually closed it — the trophy above it took most
 * of a capped card, so from the first vote onwards there was room for about
 * one row on a phone, and that row was the leader again.
 *
 * So they are two things now. The ballot is a hand of cards: everybody else
 * who played, A–Z, no numbers, never yourself, and it holds still. Pressing
 * one strikes it gold, turns it face down and stamps it, and the ballot folds
 * into a sealed card saying your vote is in. The result is the stage under it —
 * the leader on a gold card wearing the count — and the chips for everybody
 * else holding votes. Nothing is capped and nothing scrolls inside the card:
 * every name is always reachable, which is the bug the old layout was.
 *
 * ## Anonymous
 *
 * Nothing here can say who voted for whom, because nothing here is ever told.
 * The API returns counts and your own choice; the realtime event carries only
 * the fact that something moved. Small-group inference is not solved by that
 * and cannot be — with four players the second voter can work a lot out — but
 * the app never hands anyone the answer.
 *
 * Which is also why nothing per person animates when a vote lands. A count
 * that visibly ticked up on one card would be the "who just voted" that the
 * table is careful never to say. The pips are anonymous; the stage just
 * changes.
 */

/** Must equal the 58px in `.mvp-tile-card`: four across 320px, five from 390px. */
const TILE = 58;
/** Strike 0–340ms, flip 300–700ms, stamp 620–880ms, then the ballot folds. */
const SEAL_MS = 1000;
/** Past this a pip is thinner than a hairline; one bar instead. */
const MAX_PIPS = 24;
const MYANMAR = /[က-႟ꧠ-꧿ꩠ-ꩿ]/;
/** Names are data, not UI language: the script picks the rules, not the locale. */
const nameLang = (name: string) => (MYANMAR.test(name) ? 'my' : 'en');
/** The stage's inside width at 320px, the narrowest the leaders must fit. */
const STAGE_MIN = 236;
const STAR_GAP = 8;
/**
 * How the leaders stand: every one the same size, and never one left alone on
 * a row under the others — a tie drawn as 3 + 1 reads as a podium, which is a
 * tiebreak. Up to four on one line; past that, two balanced rows.
 */
function starLayout(n: number): { width: number; columns: number } {
  if (n <= 3) return { width: n === 1 ? 84 : n === 2 ? 80 : 68, columns: n };
  const columns = n === 4 ? 4 : Math.ceil(n / 2);
  const fit = Math.floor((STAGE_MIN - (columns - 1) * STAR_GAP) / columns);
  return { width: Math.min(60, fit), columns };
}

export function MvpVote({ sessionId }: { sessionId: string }) {
  const { identity } = useApp();
  const { m } = useLocale();
  const queryClient = useQueryClient();
  const mvp = useMvp(sessionId);
  const reduced = platform.display.prefersReducedMotion();
  const key = queryKeys.mvp(sessionId);

  const busy = useRef(false);
  const sealTimer = useRef<number | undefined>(undefined);
  const saidTimer = useRef<number | undefined>(undefined);
  const keyboardInBallot = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const ballotRef = useRef<HTMLUListElement>(null);
  const pickRef = useRef<HTMLDivElement>(null);
  /** Where focus goes if the control that held it is about to disappear. */
  const focusNext = useRef<'pick' | 'ballot' | null>(null);
  /** The vote whose request failed, until the next one: `undefined` when none did. */
  const failed = useRef<string | null | undefined>(undefined);
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The vote on its way to the server; `undefined` when none is. */
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const [struck, setStruck] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [said, setSaid] = useState('');

  const me = identity.memberId;
  const saved = mvp.data?.myVote ?? null;
  const myVote = pending === undefined ? saved : pending;
  const isPlayer = mvp.data?.candidates.some((c) => c.memberId === me) ?? false;
  const ballotOpen = isPlayer && (myVote === null || changing || struck !== null);

  useEffect(
    () => () => {
      window.clearTimeout(sealTimer.current);
      window.clearTimeout(saidTimer.current);
    },
    [],
  );
  // A request that failed on the way back — the vote landed, the answer was
  // lost — is contradicted by the refetch the failure asked for. The banner
  // goes when the stored vote turns out to be the one that "failed".
  useEffect(() => {
    if (failed.current === undefined || saved !== failed.current) return;
    failed.current = undefined;
    setError(null);
  }, [saved]);
  // Keyboard focus follows the ballot into the sealed card when it folds, so a
  // keyboard user is not left holding focus on a button that no longer exists.
  useEffect(() => {
    if (ballotOpen || !keyboardInBallot.current) return;
    keyboardInBallot.current = false;
    pickRef.current?.focus({ preventScroll: true });
  }, [ballotOpen]);
  // Change, Keep it, Take my vote back and a refused vote each unmount the
  // button that was pressed. Focus would fall to the page; it goes to what
  // replaced the button instead — but only if it really was lost.
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    const section = sectionRef.current;
    const active = section?.ownerDocument.activeElement;
    if (!section || (active && active !== section.ownerDocument.body)) return;
    if (target === 'pick') {
      pickRef.current?.focus({ preventScroll: true });
      return;
    }
    const ballotEl = ballotRef.current;
    const tile =
      ballotEl?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
      ballotEl?.querySelector<HTMLElement>('button');
    tile?.focus({ preventScroll: true });
  });

  if (!mvp.data) return null;
  const { candidates, tally, votesCast, voterCount, leaders } = mvp.data;
  // Nobody to vote for. Two players cannot run an award between them without
  // it being one person choosing the other.
  if (candidates.length < 3) return null;

  /**
   * Say it to a screen reader. Cleared first: a polite region only speaks when
   * its text changes, and a second vote says the same words as the first.
   */
  const announce = (text: string) => {
    window.clearTimeout(saidTimer.current);
    setSaid('');
    saidTimer.current = window.setTimeout(() => setSaid(text), 60);
  };

  const vote = async (nomineeId: string | null) => {
    if (busy.current) return;
    busy.current = true;
    failed.current = undefined;
    setInFlight(true);
    setError(null);
    setRefused(null);
    // Your own pick moves at once; the standing waits for the server, which
    // usually answers inside the second the ceremony takes. Nothing about the
    // tally is predicted here — `shared/src/mvp.ts` is what the Worker ports,
    // and a second copy of the counting rules in the browser would drift.
    setPending(nomineeId);
    window.clearTimeout(sealTimer.current);
    if (nomineeId && !reduced) {
      setStruck(nomineeId);
      sealTimer.current = window.setTimeout(() => {
        setStruck(null);
        setChanging(false);
      }, SEAL_MS);
    } else if (nomineeId) {
      setChanging(false);
    }
    try {
      const next = await castMvpVote(sessionId, nomineeId);
      // Keep the answer the POST already carries instead of asking for it a
      // second time. A read already under way may have left *after* somebody
      // else's vote — their event can beat this response home — so cancelling
      // it for this snapshot would lose that vote until the next event. When
      // one was running, it is asked for again once this answer is in.
      const racing = queryClient.getQueryState(key)?.fetchStatus === 'fetching';
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData(key, next);
      if (racing) void queryClient.invalidateQueries({ queryKey: key });
      announce(nomineeId ? m.mvp.sealed : m.mvp.takenBack);
    } catch {
      window.clearTimeout(sealTimer.current);
      failed.current = nomineeId;
      focusNext.current = 'ballot';
      setStruck(null);
      setChanging(saved !== null);
      setRefused(nomineeId);
      // Localised, not the Worker's English: a refusal here nearly always means
      // the ballot was stale, and the refetch below is the real answer.
      setError(m.mvp.failed);
      void queryClient.invalidateQueries({ queryKey: key });
    } finally {
      setPending(undefined);
      busy.current = false;
      setInFlight(false);
    }
  };

  // A ballot holds still under your thumb: A–Z, no numbers, never yourself.
  const ballot = candidates
    .filter((c) => c.memberId !== me)
    .sort((a, b) => a.memberName.localeCompare(b.memberName));
  const delta = saved === null && myVote !== null ? 1 : saved !== null && myVote === null ? -1 : 0;
  // Clamped: a voter marked absent afterwards keeps their vote in the count
  // but leaves the denominator, and "12 of 11 voted" is not a sentence. And a
  // player reading this who has not voted is proof that not everybody has, so
  // the ceiling is one lower for them — otherwise that stale vote could say
  // "All 4 voted" to the fourth, and their own vote would move nothing.
  const ceiling = voterCount - (isPlayer && myVote === null ? 1 : 0);
  const cast = Math.max(0, Math.min(votesCast + delta, ceiling));
  const full = voterCount > 0 && cast >= voterCount;
  const winners = tally.filter((e) => leaders.includes(e.memberId));
  const chase = tally.filter((e) => e.votes > 0 && !leaders.includes(e.memberId));
  const open = isPlayer && myVote === null && struck === null;
  const waiting = open && !changing;
  // Only when it is true for the person reading it: a tie they are not part
  // of, with a leader they could actually vote for. Telling somebody who is
  // themselves tied that their vote breaks it would be telling them to vote
  // for the other one.
  const canBreakTie =
    leaders.length > 1 &&
    !leaders.includes(me) &&
    leaders.some((id) => candidates.some((c) => c.memberId === id));
  const hook =
    cast === 0 ? m.mvp.hookFirst : canBreakTie ? m.mvp.hookTie : m.mvp.hookTurn(cast, voterCount);
  const pickName = tally.find((e) => e.memberId === myVote)?.memberName ?? '';

  return (
    <section ref={sectionRef} className="card mvp-card" aria-labelledby={`mvp-title-${sessionId}`}>
      <h2 id={`mvp-title-${sessionId}`} className="mvp-title">
        {m.mvp.title}
      </h2>

      {!isPlayer ? <p className="muted mvp-lede">{m.mvp.playersOnly}</p> : null}
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {open ? <p className="mvp-hook">{hook}</p> : null}

      {ballotOpen ? (
        <ul
          ref={ballotRef}
          className={`mvp-ballot${waiting ? ' is-waiting' : ''}`}
          aria-label={m.mvp.ballot}
          aria-busy={inFlight}
          onFocusCapture={() => {
            keyboardInBallot.current = true;
          }}
          onBlurCapture={() => {
            keyboardInBallot.current = false;
          }}
        >
          {ballot.map((c, i) => {
            const picked = c.memberId === myVote;
            const isStruck = c.memberId === struck;
            // While a vote is on its way the others are inert — not dimmed,
            // because nothing is wrong with them, but a press would otherwise
            // click and buzz like a vote and then be dropped, and the sealed
            // card that follows never says whose name went in.
            const held = inFlight && !picked;
            return (
              <li key={c.memberId} style={{ '--i': i } as CSSProperties}>
                <button
                  type="button"
                  className={`mvp-tile${isStruck ? ' is-struck' : ''}${refused === c.memberId ? ' is-refused' : ''}`}
                  aria-pressed={picked}
                  aria-disabled={held || undefined}
                  aria-label={m.mvp.ballotLabel(c.memberName)}
                  // Pressing your own pick again keeps it: no request, no sound.
                  // Taking a vote back is its own button, never a second tap.
                  data-sound={picked ? 'none' : undefined}
                  data-haptic={picked ? undefined : 'in'}
                  onClick={() => {
                    if (busy.current) return;
                    if (picked) setChanging(false);
                    else void vote(c.memberId);
                  }}
                  onAnimationEnd={(event) => {
                    if (event.animationName === 'ff-mvp-refuse') setRefused(null);
                  }}
                >
                  <span className="mvp-tile-card" aria-hidden="true">
                    <span className="mvp-flip">
                      <span className="pack-front">
                        <ItemCard
                          width={TILE}
                          metal={picked ? 'gold' : 'silver'}
                          portrait={
                            <Avatar
                              memberId={c.memberId}
                              name={c.memberName}
                              avatarUpdatedAt={c.memberAvatarUpdatedAt}
                              size={TILE}
                              tinted={false}
                              initialsScale={0.3}
                            />
                          }
                        />
                      </span>
                      {isStruck ? (
                        <span className="pack-back mvp-seal">
                          <Icon name="check" size={22} />
                        </span>
                      ) : null}
                    </span>
                    <span className="mvp-glint" />
                    {isStruck ? <span className="mvp-stamp">{m.mvp.stamp}</span> : null}
                  </span>
                  <span className="mvp-tile-name" lang={nameLang(c.memberName)} aria-hidden="true">
                    {c.memberName}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {isPlayer && changing && myVote !== null && struck === null ? (
        <div className="mvp-change">
          <Button
            variant="text"
            sound="tap-out"
            disabled={inFlight}
            onClick={() => {
              focusNext.current = 'ballot';
              void vote(null);
            }}
          >
            {m.mvp.takeItBack}
          </Button>
          <Button
            variant="text"
            sound="none"
            onClick={() => {
              focusNext.current = 'pick';
              setChanging(false);
            }}
          >
            {m.mvp.keep}
          </Button>
        </div>
      ) : null}

      {/*
        Your vote, face down. Only on your own phone, and even here the name is
        for a screen reader alone: the card is held up at the pitch, and the
        person beside you reading "you voted for Aung" is exactly the moment
        that made the ballot awkward to use.
      */}
      {isPlayer && myVote !== null && !ballotOpen ? (
        <div className="mvp-pick" ref={pickRef} tabIndex={-1}>
          <span className="mvp-pick-card" aria-hidden="true">
            <Icon name="check" size={18} />
          </span>
          <span className="mvp-pick-text">
            <strong className="mvp-pick-title">{m.mvp.sealed}</strong>
            <span className="mvp-pick-note">{m.mvp.sealedNote}</span>
            <span className="sr-only">{m.mvp.votedFor(pickName)}</span>
          </span>
          <Button
            variant="text"
            sound="none"
            onClick={() => {
              focusNext.current = 'ballot';
              setChanging(true);
            }}
          >
            {m.mvp.change}
          </Button>
        </div>
      ) : null}

      <div className="mvp-stage">
        {/* Persistent live region; the hero inside remounts per leader set, so
            a new leader is announced and plays its entrance again. */}
        <div className={`mvp-hero${winners.length > 1 ? ' is-shared' : ''}`} aria-live="polite">
          <MvpHero key={leaders.join(',') || 'open'} winners={winners} meId={me} />
        </div>
        <div className={`mvp-turnout${full ? ' is-full' : ''}`}>
          {voterCount <= MAX_PIPS ? (
            <span className="mvp-pips" aria-hidden="true">
              {Array.from({ length: voterCount }, (_, i) => (
                <span
                  key={i}
                  className={`mvp-pip${i < cast ? ' is-in' : ''}`}
                  style={{ '--i': i } as CSSProperties}
                />
              ))}
            </span>
          ) : (
            <span
              className="mvp-bar"
              aria-hidden="true"
              style={{ '--p': voterCount > 0 ? cast / voterCount : 0 } as CSSProperties}
            />
          )}
          <span className="mvp-turnout-text">
            {full ? m.mvp.allIn(voterCount) : m.mvp.turnout(cast, voterCount)}
          </span>
        </div>
      </div>

      {/* Everybody else holding votes. Never a column of zeros: a list of
          people on nothing is the sentence "nobody does this". */}
      {chase.length > 0 ? (
        <ul className="mvp-chase">
          {chase.map((e) => (
            <li key={e.memberId} className="mvp-chip">
              <Avatar
                memberId={e.memberId}
                name={e.memberName}
                avatarUpdatedAt={e.memberAvatarUpdatedAt}
                size={22}
              />
              <span className="truncate mvp-chip-name" lang={nameLang(e.memberName)}>
                {e.memberName}
              </span>
              <b aria-hidden="true">{e.votes}</b>
              <span className="sr-only">{m.mvp.votes(e.votes)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mvp-foot">{m.mvp.countsToward}</p>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </section>
  );
}

/**
 * The leader, on a stage.
 *
 * Keyed by the leader set, so a change of leader remounts it and the entrance
 * plays for the new name — and only then: more votes for the same person do
 * not replay it.
 */
function MvpHero({ winners, meId }: { winners: MvpTallyEntry[]; meId: string }) {
  const { m } = useLocale();

  // Nobody leads on zero votes: an empty place, not a joint award to everybody.
  if (winners.length === 0) {
    return (
      <>
        <span className="mvp-rays" aria-hidden="true" />
        <span className="mvp-star-card" aria-hidden="true">
          <ItemCard width={84} metal="gold" open portrait={<span className="ic-glyph mvp-q">?</span>} />
        </span>
        <span className="mvp-hero-text">
          <span className="mvp-kicker">{m.mvp.kicker}</span>
          <span className="mvp-foil">{m.mvp.upForGrabs}</span>
        </span>
      </>
    );
  }

  const shared = winners.length > 1;
  const { width, columns } = starLayout(winners.length);
  const votes = winners[0]!.votes;
  const cards = winners.map((w, k) => (
    <span
      key={w.memberId}
      className="mvp-star-card"
      style={{ '--k': k } as CSSProperties}
      aria-hidden="true"
    >
      <ItemCard
        width={width}
        tier="podium"
        metal="gold"
        isMe={w.memberId === meId}
        rating={w.votes}
        code={m.mvp.codeVotes}
        name={shared ? w.memberName : undefined}
        portrait={
          <Avatar
            memberId={w.memberId}
            name={w.memberName}
            avatarUpdatedAt={w.memberAvatarUpdatedAt}
            size={width}
            tinted={false}
            initialsScale={0.26}
          />
        }
      />
      <span className="mvp-glint" />
    </span>
  ));

  // A tie is several names at the same size, in the server's order, and none
  // of them first — a tiebreak drawn as a layout is still a tiebreak.
  if (shared) {
    return (
      <>
        <span className="mvp-rays" aria-hidden="true" />
        <span className="mvp-kicker">{m.mvp.kickerShared}</span>
        <span
          className="mvp-stars"
          style={{ maxWidth: columns * width + (columns - 1) * STAR_GAP }}
        >
          {cards}
        </span>
        <span className="sr-only">{winners.map((w) => w.memberName).join(', ')}</span>
        <span className="mvp-note">{m.mvp.shared(votes)}</span>
      </>
    );
  }

  const w = winners[0]!;
  return (
    <>
      <span className="mvp-rays" aria-hidden="true" />
      {cards}
      <span className="mvp-hero-text">
        <span className="mvp-kicker">{m.mvp.kicker}</span>
        <span className="mvp-foil" lang={nameLang(w.memberName)}>
          {w.memberName}
        </span>
        <span className="mvp-note">{m.mvp.leadingWith(votes)}</span>
      </span>
    </>
  );
}
