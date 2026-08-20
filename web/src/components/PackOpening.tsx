import { type TeamDraw, TEAM_LETTERS, slotKey } from '@futsal/shared';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { clockIsSynced, serverNow } from '../api/clock.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Avatar } from './Avatar.js';
import { ItemCard } from './ItemCard.js';

/**
 * The draw, opened rather than displayed.
 *
 * The board underneath already deals its names out one at a time, and that is
 * there for a reason worth keeping: a random draw is only useful if the group
 * accepts it, and a board that blinks from one arrangement to another looks
 * like somebody edited it. This is the same argument taken as far as it goes.
 * Everybody is standing on the pitch with their phones out, the draw lands on
 * every one of them in the same instant over the same channel, and for eight
 * seconds they are all watching the same cards turn over.
 *
 * ## It plays for the group, not for the presser
 *
 * Triggered by `drawnAt` changing while this is on screen — which is exactly
 * the set of people who are looking at the session when somebody shuffles.
 * Anybody who opens the app later gets the board and no ceremony, because a
 * reveal of something that happened an hour ago is a cutscene, not an event.
 *
 * ## Why it can always be skipped
 *
 * It sits between the group and a board they may urgently need — somebody is
 * about to kick off. One tap anywhere ends it, the last card lands on its own
 * after a beat, and a reader who has asked for less motion gets the whole
 * thing at once with no flips at all.
 */
export function PackOpening({
  draw,
  onDone,
}: {
  draw: TeamDraw;
  onDone(): void;
}) {
  const { identity } = useApp();
  const { m } = useLocale();
  const reduced = platform.display.prefersReducedMotion();

  /** How many cards have turned. Everything before this index is face up. */
  const [turned, setTurned] = useState(reduced ? Infinity : 0);

  // Flattened in board order, so the reveal runs team by team the way the
  // board reads rather than in some order of its own.
  const cards = draw.teams.flatMap((team, index) =>
    team.map((slot) => ({ slot, team: index })),
  );

  /*
   * Every device turns the same card at the same instant.
   *
   * Not "start counting when the draw arrives", which was the first version and
   * which cannot be in sync by construction. Whoever pressed shuffle learns the
   * result from their own request coming back; everybody else waits for the
   * broadcast, which is a further trip through Redis and down an event stream.
   * That head start alone was a few hundred milliseconds, and the jitter
   * between one subscriber and the next added more on top.
   *
   * So the reveal is a function of the clock rather than of arrival. `drawnAt`
   * is a server timestamp that every device receives identically, `serverNow`
   * is that same clock as measured locally, and the card index is simply how
   * far into the reveal that pair says we are. A phone that hears about the
   * draw late joins the reveal already in progress instead of running its own
   * copy of it — which is what being in sync actually means, and is also the
   * honest answer, because it cannot go back in time.
   *
   * Recomputed on every tick rather than incremented, so a tab that was
   * throttled while backgrounded lands on the right card instead of finishing
   * late by however long it was starved.
   */
  useEffect(() => {
    if (reduced) return;

    const startedAt = Date.parse(draw.drawnAt);
    const positionNow = () =>
      clockIsSynced() && Number.isFinite(startedAt)
        ? Math.floor((serverNow() - startedAt) / TURN_MS)
        : null;

    // Without a usable clock this behaves the way it used to: its own reveal,
    // from the beginning. Better a private ceremony than none.
    let fallback = 0;
    let announced = positionNow() ?? 0;
    setTurned(Math.max(0, Math.min(announced, cards.length)));

    const timer = window.setInterval(() => {
      fallback += 1;
      const next = Math.min(positionNow() ?? fallback, cards.length);
      if (next <= announced) return;

      /*
       * One clip and at most one buzz per tick, however many cards the tick
       * covered.
       *
       * A device joining late, or one coming back from being throttled, can
       * cross several cards at once. Playing a clip for each would be a burst
       * of clicks that says nothing, and the retrigger floor in `platform`
       * would eat most of them anyway.
       */
      const crossed = cards.slice(Math.max(0, announced), next);
      announced = next;
      setTurned(next);
      platform.sound.play('press');
      if (crossed.some((card) => card.slot.memberId === identity.memberId)) {
        platform.haptics.buzz('in');
      }
      if (next >= cards.length) window.clearInterval(timer);
    }, TICK_MS);

    return () => window.clearInterval(timer);
    // Keyed to the draw alone: re-running this on a re-render would restart the
    // reveal, and `cards` is rebuilt on every one of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw.drawnAt, reduced]);

  /*
   * A hard ceiling, whatever else happens.
   *
   * This covers the whole screen and the board underneath is the thing the
   * group is waiting for, so the one failure that must not be possible is it
   * staying up. The interval below and the tap both dismiss it; this is the
   * backstop for the case where neither ran — a throw inside a clip, a timer
   * starved by a backgrounded tab — because "stuck behind a cutscene" is a
   * worse bug than any it could be hiding.
   */
  useEffect(() => {
    const timer = window.setTimeout(onDone, cards.length * TURN_MS + 6000);
    return () => window.clearTimeout(timer);
  }, [cards.length, onDone]);

  // Off on its own once the last card has been up long enough to look at.
  useEffect(() => {
    if (turned < cards.length) return;
    const timer = window.setTimeout(onDone, reduced ? 2400 : 1600);
    return () => window.clearTimeout(timer);
  }, [turned, cards.length, onDone, reduced]);

  return (
    <div
      className="pack"
      role="dialog"
      aria-modal="true"
      aria-label={m.teams.drawLabel}
      onClick={onDone}
    >
      <p className="pack-title">{m.teams.opening}</p>
      <div className="pack-teams">
        {draw.teams.map((team, index) => (
          <div className="pack-team" key={index}>
            <span className="pack-letter">{TEAM_LETTERS[index]}</span>
            <div className="pack-row">
              {team.map((slot) => {
                const position = cards.findIndex((card) => card.slot === slot);
                const up = position < turned;
                return (
                  <span
                    key={slotKey(slot)}
                    className={`pack-card${up ? ' is-up' : ''}`}
                    style={{ '--pack-i': position } as CSSProperties}
                  >
                    {/*
                      Both faces are always in the DOM and one is turned away.
                      Mounting the front on reveal would fetch its picture at
                      the moment it is needed, which is the one moment there is
                      no time for a request.
                    */}
                    <span className="pack-back" aria-hidden="true" />
                    <span className="pack-front">
                      <ItemCard
                        width={PACK_CARD}
                        metal={slot.memberId === identity.memberId ? 'steel' : 'gold'}
                        isMe={slot.memberId === identity.memberId}
                        name={slot.guestIndex > 0 ? undefined : slot.memberName}
                        portrait={
                          <Avatar
                            memberId={slot.memberId}
                            name={slot.memberName}
                            avatarUpdatedAt={slot.memberAvatarUpdatedAt}
                            size={PACK_CARD}
                            tinted={false}
                            initialsScale={0.3}
                          />
                        }
                      />
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="pack-skip">{m.teams.tapToSkip}</p>
    </div>
  );
}

/**
 * Long enough to be an event, short enough that nobody is waiting on it.
 *
 * Twelve cards at this interval is a shade over four seconds, which is about
 * the length of a goal celebration and about as long as a group of people
 * holding a ball will stand still for.
 */
const TURN_MS = 340;

/**
 * How often the clock is consulted.
 *
 * Finer than a turn, because the tick and the turn are no longer the same
 * thing: the reveal advances when the shared clock says it should, and this
 * only decides how promptly that is noticed. A quarter of a turn keeps the
 * worst-case lateness under a tenth of a second while costing four timer
 * wake-ups a second for the few seconds this is on screen.
 */
const TICK_MS = 80;

/** Six across a narrow phone, with the gaps. */
const PACK_CARD = 52;
