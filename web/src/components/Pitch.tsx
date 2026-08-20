import {
  PITCH_CARD_RATIO,
  PITCH_LINE_GAP,
  type SessionDetail,
  type TeamSlot,
  partyFits,
  pitchLines,
  pitchSlotCount,
  pitchSlotSize,
  pitchSpotGap,
  placeOnPitch,
  registeredSlots,
  slotKey,
  waitingSlots,
} from '@futsal/shared';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { moveOnPitch, registerForSession, withdrawFromSession } from '../api/sessions.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Avatar } from './Avatar.js';
import { GuestPicker } from './GuestPicker.js';
import { Icon } from './Icon.js';
import { PitchTurf } from './PitchTurf.js';
import { ErrorBanner } from './ui.js';

/**
 * Signing up, as a place to stand.
 *
 * This was a button and a list. The list is still below, because it is what the
 * team draw deals from and where attendance and goals live — but it was never
 * the fast answer to the question people open the app for. A field of spots is:
 * you count the gaps, not the names, and the one thing the screen is *for*
 * becomes a target rather than a sentence.
 *
 * ## Every spot is a button, or it is not a control at all
 *
 * The rule the whole component turns on:
 *
 * > A spot is a `<button>` if and only if pressing it does something the server
 * > will act on. Everything else is a `<span>`.
 *
 * An empty circle is therefore pressable in two different senses, and which one
 * is on offer follows entirely from whether you are already out there. If you
 * are not, it takes the spot. If you are, it moves you to it — the same one
 * tap, because a member who has just learned that pressing a gap puts them
 * there has learned the whole gesture, and making the second use of it ask
 * twice would be teaching an exception rather than a rule.
 *
 * What is not on offer is a third thing. Registering is
 * `WHERE NOT EXISTS (session_id, member_id)` on the Worker side, so a second
 * *join* from somebody already registered is a 200 that changes nothing — which
 * is why moving is its own route rather than a re-register with a new number.
 * And a waitlisted member gets spans again: the bench is one place rather than
 * a row of them, so there is nowhere on the field for them to move to yet.
 *
 * It also settles the sound for free. A `<span>` matches nothing in the
 * document listener's selector set, so a spot that does nothing makes no noise
 * without a line of code spent on it.
 *
 * ## Why leaving asks twice
 *
 * Your own spot is an unlabelled circle with your face on it, and pressing it
 * gives up your place in a game. The Button below still leaves in one press —
 * it has words on it — so nobody's primary path got slower; it is only the
 * graphical route that asks again. It is also the one gesture in the app that
 * the two clips genuinely narrate rather than merely label: the first press
 * arms and clicks, the second leaves and thuds.
 *
 * ## What is deliberately not here
 *
 * No names. A 44px disc cannot hold one, and Burmese cannot be truncated and
 * sets about a third taller than Latin at the same size — a caption under each
 * spot was measured colliding with the line below at a normal roster of twelve.
 * Identity lives in the label a screen reader reads and in the roster card one
 * card down.
 *
 * There is no "I'm in" button beside the field, and that is the point of the
 * change rather than an omission. It does mean the pitch has to carry the two
 * things the button was quietly covering — joining when there is no room, and
 * leaving a waitlist you are already on — so both became what they are in a
 * real game: spots on the touchline. The bench appears only when it has
 * something to say, and a spot on it is a control under exactly the same rule
 * as a spot on the field.
 *
 * No pitch at all after kickoff. The server refuses both registering and
 * withdrawing once the whistle has gone, so every spot would be an affordance
 * that lies — and there is no honest thing to draw instead, because a pitch of
 * who *registered* contradicts the attendance marks directly below it.
 */
export function Pitch({
  detail,
  recentlyChanged,
  onChanged,
}: {
  detail: SessionDetail;
  /** Member ids the live stream just changed, for the existing `.flash`. */
  recentlyChanged: Set<string>;
  onChanged(): void;
}) {
  const { identity, toast } = useApp();
  const { m, locale } = useLocale();
  const { session, registrations, registrationOpen, me } = detail;

  /** `armed` is your own spot having been pressed once and asking again. */
  type Phase = 'idle' | 'armed' | 'joining' | 'leaving' | 'moving';
  const [phase, setPhase] = useState<Phase>('idle');
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * Whether the keyboard is inside the pitch, tracked with React's own capture
   * props rather than `document.activeElement` — components do not touch the
   * document (see `platform/index.ts`). It holds the disarm timer open, because
   * a screen reader may still be reading the label out.
   */
  const [focusWithin, setFocusWithin] = useState(false);
  /*
   * The deal is for arriving at the screen, not for using it.
   *
   * An uncapped session has exactly as many spots as it has people plus one, so
   * every join and every withdrawal reshapes the whole formation — and a spot
   * that lands in a different row than it was in is a different React node,
   * mounted fresh. Left unguarded that re-ran the stagger on five or six spots
   * every time somebody tapped, which is a wave washing across the pitch as an
   * answer to a single press.
   *
   * So the stagger belongs to the first sight of the field and nothing else.
   * After that a spot appearing is marked the way every other live change in the
   * app is marked — the flash — and the field itself stays still.
   */
  const [dealing, setDealing] = useState(true);
  /*
   * Whether the field recedes, which this device decides and nothing else does.
   *
   * Read on every render rather than held in state: it is a synchronous look at
   * one key, the switch lives on another screen, and reading it fresh is what
   * makes coming back from that screen show the change without a word of
   * plumbing between the two.
   */
  const perspective = platform.display.pitchPerspective();

  const busy = phase === 'joining' || phase === 'leaving' || phase === 'moving';

  /*
   * The picture and the sentence are both derived from this one array, so they
   * cannot disagree. `counts.in` from the server says the same thing, but going
   * through it would let a stale count caption a fresh field.
   */
  const headsIn = registeredSlots(registrations).length;
  const total = pitchSlotCount(headsIn, session.maxPlayers, registrationOpen);
  const openCount = Math.max(0, total - headsIn);
  const lines = pitchLines(total);
  const spotSize = pitchSlotSize(lines);

  /*
   * Where everybody actually stood, not the order they arrived in.
   *
   * Filling the circles by registration order was fine while signing up was a
   * button — nobody could tell. Once pressing a *particular* circle is how you
   * sign up, it is a lie you can watch happen: you aim at the gap near your
   * thumb and your face appears near the halfway line, because that gap came
   * first in the array.
   */
  const placement = placeOnPitch(registrations, total);
  const spots: Spot[] = placement.map((slot, index) =>
    slot
      ? { kind: 'taken' as const, key: slotKey(slot), slot }
      : { kind: 'open' as const, key: `open:${index}` },
  );

  /** Only when there is genuinely a free spot with your name on it. */
  const canJoin = !me && registrationOpen && openCount > 0;

  /*
   * Already out there, so a gap is somewhere to go rather than somewhere to
   * join. `status === 'in'` and not merely registered: a waitlisted member has
   * no card on the field, and storing a spot for them would be a claim staked
   * silently on a pitch they are not on yet.
   */
  const canMove = me?.status === 'in' && registrationOpen;

  /*
   * The touchline.
   *
   * Shown only when it has something to say: somebody is waiting, or the field
   * is full and pressing here is the only way in. A party that does not fit the
   * gaps is why both can be true at once — the server benches it whole and the
   * gaps stay open, which is what `partyStuck` explains underneath.
   */
  const waiting = waitingSlots(registrations);
  const canWait = !me && registrationOpen && openCount === 0;
  const bench: Spot[] = [
    ...waiting.map((slot) => ({ kind: 'taken' as const, key: slotKey(slot), slot })),
    ...(canWait ? [{ kind: 'open' as const, key: 'bench:0' }] : []),
  ];
  // Subordinate to the field, and never larger than what is on it.
  const benchSize = Math.min(36, spotSize);

  /*
   * The one case where empty spots are correct and still not yours.
   *
   * Promotion takes the first waitlisted party that *fits*, not the first in
   * line, so a party of three sits behind two free spots indefinitely. Nowhere
   * else in the app explains that, and without a sentence it reads as a bug.
   */
  const partyStuck =
    me?.status === 'waitlist' &&
    openCount > 0 &&
    !partyFits(headsIn, session.maxPlayers, me.guests);

  // Comfortably past the longest stagger plus the animation itself, so nothing
  // is cut off mid-deal.
  useEffect(() => {
    const timer = window.setTimeout(() => setDealing(false), 900);
    return () => window.clearTimeout(timer);
  }, []);

  /*
   * The two lessons the pitch has to teach, each once, when it is the lesson.
   *
   * Not a tour of the app. There is exactly one thing here that a person has to
   * be told rather than shown — that giving a spot up asks twice — and one that
   * is worth pointing at the first time because the field replaced a button
   * that used to say what it did.
   *
   * Which one is due follows from whether you are on the pitch, so nobody is
   * taught to leave before they have arrived, and taking your spot rolls
   * straight into the only other thing there is to know. Both are marked seen
   * only once they have actually opened — a lesson nobody saw is not taught,
   * and the spot it was about may have gone in the moment before it ran.
   *
   * Everyone who can see this screen is signed in and in the group already;
   * `App` will not render anything else until both are true. So there is no
   * check for it here — a second one would only be able to disagree.
   */
  const onPitch = me !== null;
  useEffect(() => {
    if (!registrationOpen || dealing) return;
    /*
     * Candidates in the order they become worth knowing, first unseen wins.
     *
     * Moving is its own lesson rather than a second step on the tap-out one,
     * and that is about the people who were here before it existed: a lesson
     * already marked seen never opens again, so folding it in would have taught
     * it to nobody who already knew how to leave. A separate key reaches them
     * the next time they are on the pitch.
     */
    const lessons = onPitch
      ? [
          { key: 'tour:tap-out', target: '.pitch-spot.is-me', title: m.pitch.tour.tapOutTitle, body: m.pitch.tour.tapOutBody },
          { key: 'tour:move', target: '.pitch-spot.is-open', title: m.pitch.tour.moveTitle, body: m.pitch.tour.moveBody },
        ]
      : [
          { key: 'tour:tap-in', target: '.pitch-spot.is-open', title: m.pitch.tour.tapInTitle, body: m.pitch.tour.tapInBody },
        ];
    // Nowhere to move to is nothing to teach — and the tour would point at a
    // spot that is not on the field.
    const due = lessons.filter((l) => l.key !== 'tour:move' || openCount > 0);
    const lesson = due.find((l) => platform.storage.get(l.key) !== 'seen');
    if (!lesson) return;

    // A beat after the deal settles, so it points at a field that has stopped
    // moving rather than at a card still sliding into place.
    const timer = window.setTimeout(() => {
      void platform.tour
        .show([{ target: lesson.target, title: lesson.title, body: lesson.body }], {
          dismiss: m.pitch.tour.gotIt,
          lang: locale,
        })
        // On screen is taught. Whether it was read, dismissed or answered by
        // doing the thing it asked for are all the same lesson, and a tour that
        // repeated because somebody acted on it immediately would be a strange
        // one.
        .then((shown) => {
          if (shown) platform.storage.set(lesson.key, 'seen');
        });
    }, 400);

    return () => {
      window.clearTimeout(timer);
      // Taking a spot swaps which lesson is due, and the one on screen is
      // pointing at a card that is no longer the right card.
      platform.tour.stop();
    };
  }, [registrationOpen, dealing, onPitch, openCount, m, locale]);

  // The arm lapses on its own, so a pocket press cannot leave a live confirm
  // sitting there — but not while the keyboard is still on it.
  useEffect(() => {
    if (phase !== 'armed' || focusWithin) return;
    const timer = window.setTimeout(() => setPhase('idle'), ARM_MS);
    return () => window.clearTimeout(timer);
  }, [phase, focusWithin]);

  // Somebody else's withdrawal can promote you, or another device can drop you,
  // while your own spot is armed. Either way the confirm is about a spot that
  // is no longer the one you pressed.
  useEffect(() => {
    if (!me) setPhase((current) => (current === 'armed' ? 'idle' : current));
  }, [me]);

  const join = async (key: string, slot: number | null) => {
    if (busy) return;
    setPhase('joining');
    setPendingKey(key);
    setError(null);
    try {
      // The spot goes with the registration, so every other phone draws them
      // standing where they pressed rather than in the first gap it has.
      const result = await registerForSession(session.id, 0, slot);
      toast(
        result.registration?.status === 'waitlist' ? m.toast.youreOnWaitlist : m.toast.youreIn,
      );
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.session.thatDidNotWork);
    } finally {
      setPhase('idle');
      setPendingKey(null);
    }
  };

  /*
   * Change where you stand, without touching whether you are playing.
   *
   * Deliberately not a withdraw followed by a register. That would be the same
   * two words to a database and a completely different thing to a person: it
   * would drop you to the back of the queue, hand your spot to the first person
   * on the waitlist in the instant between the two calls, and leave you
   * watching somebody else take the game you were already in. Wanting to stand
   * somewhere else is not wanting to risk that.
   */
  const move = async (key: string, slot: number) => {
    if (busy) return;
    setPhase('moving');
    setPendingKey(key);
    setError(null);
    try {
      await moveOnPitch(session.id, slot);
      toast(m.toast.youMoved);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.session.thatDidNotWork);
    } finally {
      setPhase('idle');
      setPendingKey(null);
    }
  };

  const leave = async (key: string | null) => {
    if (busy) return;
    setPhase('leaving');
    setPendingKey(key);
    setError(null);
    try {
      const result = await withdrawFromSession(session.id);
      toast(
        result.promoted ? m.toast.youreOutPromoted(result.promoted.memberName) : m.toast.youreOut,
      );
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.session.thatDidNotWork);
    } finally {
      setPhase('idle');
      setPendingKey(null);
    }
  };

  /*
   * What the caption says, most urgent first.
   *
   * An action in flight outranks everything, including the no-cap note — an
   * uncapped session is the common week, and it is exactly where a member would
   * otherwise get no word at all that their press had landed. That matters
   * beyond tidiness: for a reader who has asked for less motion, the dimmed
   * spot stops animating and this sentence is the whole of the feedback.
   */
  const status: ReactNode = busy
    ? phase === 'joining'
      ? m.pitch.joining
      : phase === 'moving'
        ? m.pitch.moving
        : m.pitch.leaving
    : session.maxPlayers == null
      ? m.pitch.noCap
      : openCount === 0
        ? m.pitch.full
        : m.pitch.spotsLeft(openCount);

  const statusBody = busy
    ? null
    : session.maxPlayers == null
      ? m.pitch.noCapBody
      : openCount === 0
        ? m.pitch.fullBody
        : null;

  const firstOpen = spots.findIndex((spot) => spot.kind === 'open');

  /*
   * The number on the card.
   *
   * A player item wears a rating. This app has none, and inventing one would be
   * a figure that means nothing — but it does have the order people said yes
   * in, which is real, already runs down the side of the roster, and reads as a
   * squad number: first to sign up wears 1.
   */
  const shirtNumbers = new Map<string, number>();
  placement.forEach((slot) => {
    if (slot) shirtNumbers.set(slotKey(slot), shirtNumbers.size + 1);
  });
  const shirtOf = (spot: Spot) => (spot.kind === 'taken' ? shirtNumbers.get(spot.key) : undefined);

  return (
    <div className="card pitch-card">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div
        className="pitch"
        role="group"
        /*
         * The only instruction somebody using a screen reader hears on entering
         * the region, so it has to say which of the two offers is live. It said
         * "press an empty spot to take it" to everybody, including the people
         * for whom an empty spot is somewhere to move to and taking one is not
         * on the table at all.
         */
        aria-label={canMove ? m.pitch.labelOnPitch : m.pitch.label}
        style={
          {
            '--ff-spot': `${spotSize}px`,
            '--ff-spot-h': `${Math.round(spotSize * PITCH_CARD_RATIO)}px`,
            '--ff-spot-gap': `${pitchSpotGap(lines)}px`,
            '--ff-line-gap': `${PITCH_LINE_GAP}px`,
          } as CSSProperties
        }
        onFocusCapture={() => setFocusWithin(true)}
        onBlurCapture={() => setFocusWithin(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && phase === 'armed') setPhase('idle');
        }}
      >
        {/*
          The field is laid out flat and then tilted back, the way the squad and
          match-preview screens show it. The cards stand up again inside it —
          see `.pitch-spot` — so the ground recedes and the players do not.
        */}
        <div className="pitch-field">
          <PitchTurf flat={!perspective} />
          <div className={`pitch-rows${dealing ? ' is-dealing' : ''}`}>
            {lines.map((width, line) => {
              const from = lines.slice(0, line).reduce((a, b) => a + b, 0);
              /*
                 Depth, faked in two dimensions on purpose.
       
                 Only the grass is rotated. A card inside a 3D subtree is still
                 being projected even after it is counter-rotated upright, and
                 the projection skews it — which is exactly what made these look
                 tilted. Scaling a flat row instead gives the same convergence
                 with cards that stay square to the screen.
              */
              /*
                 Flat means every row is the near row.
       
                 Not "no depth": the rows are laid out as a fraction of the same
                 taper the turf is drawn from, so a depth of 1 everywhere is
                 exactly the width and scale the nearest row already had, and it
                 lines up with a field whose far end is now that wide too. A
                 depth of 0 would agree just as well and draw everything at the
                 far end's size, which is smaller for no reason.
              */
              const depth = !perspective ? 1 : lines.length > 1 ? line / (lines.length - 1) : 1;
              return (
                <div
                  className="pitch-line-row"
                  key={line}
                  style={
                    {
                      '--ff-row-depth': depth.toFixed(3),
                      '--ff-row-scale': (0.76 + 0.24 * depth).toFixed(3),
                    } as CSSProperties
                  }
                >
                  {spots.slice(from, from + width).map((spot, offset) => {
                    const index = from + offset;
                    return renderSpot({
                    spot,
                    index,
                    shirt: shirtOf(spot),
                    isFirstOpen: index === firstOpen,
                    viewerId: identity.memberId,
                    canJoin,
                    canMove,
                    onBench: false,
                    armed: phase === 'armed',
                    pending: pendingKey === spot.key,
                    busy,
                    spotSize,
                    recentlyChanged,
                    m,
                    onJoin: join,
                    onMove: move,
                    onArm: () => setPhase('armed'),
                    onLeave: leave,
                  });
                })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {bench.length > 0 ? (
        <div
          className="pitch-bench"
          role="group"
          aria-label={m.pitch.benchLabel}
          style={{ '--ff-spot': `${benchSize}px`, '--ff-spot-gap': '6px' } as CSSProperties}
        >
          {bench.map((spot, index) =>
            renderSpot({
              spot,
              index,
              shirt: undefined,
              isFirstOpen: spot.kind === 'open',
              viewerId: identity.memberId,
              canJoin: canWait,
              canMove: false,
              armed: phase === 'armed',
              pending: pendingKey === spot.key,
              busy,
              spotSize: benchSize,
              onBench: true,
              recentlyChanged,
              m,
              onJoin: join,
              onMove: move,
              onArm: () => setPhase('armed'),
              onLeave: leave,
            }),
          )}
        </div>
      ) : null}

      {/*
        The only thing on this screen that announces a live roster change. The
        text is derived from the spots rather than kept in state, so the
        thirty-second poll rewrites an identical string and React leaves the
        node alone — no repeat announcements.
      */}
      <p className="pitch-status" role="status">
        {status}
      </p>
      {statusBody ? <p className="pitch-why muted">{statusBody}</p> : null}
      {partyStuck && me ? (
        <p className="pitch-why muted">{m.pitch.partyTooBig(1 + me.guests, openCount)}</p>
      ) : null}

      {/* Only once you are in: bringing friends to a session you are not
          playing in is not a thing, and the cap check needs a spot to measure
          against. */}
      {me ? (
        <GuestPicker sessionId={session.id} guests={me.guests} onChanged={onChanged} />
      ) : null}
    </div>
  );
}

/** Long enough to look at your own face and mean it, short enough to lapse. */
const ARM_MS = 4000;

type Spot =
  | { kind: 'taken'; key: string; slot: TeamSlot }
  | { kind: 'open'; key: string };

function renderSpot({
  spot,
  index,
  shirt,
  isFirstOpen,
  viewerId,
  canJoin,
  canMove,
  armed,
  pending,
  busy,
  spotSize,
  onBench,
  recentlyChanged,
  m,
  onJoin,
  onMove,
  onArm,
  onLeave,
}: {
  spot: Spot;
  index: number;
  /** Their place in the signup order, worn like a squad number. */
  shirt: number | undefined;
  isFirstOpen: boolean;
  viewerId: string;
  canJoin: boolean;
  /** You are on the pitch already, so an empty spot is somewhere to go. */
  canMove: boolean;
  armed: boolean;
  pending: boolean;
  busy: boolean;
  spotSize: number;
  /** Waiting rather than playing, which only changes what the labels say. */
  onBench: boolean;
  recentlyChanged: Set<string>;
  m: ReturnType<typeof useLocale>['m'];
  onJoin(key: string, slot: number | null): void;
  onMove(key: string, slot: number): void;
  onArm(): void;
  onLeave(key: string): void;
}) {
  const open = spot.kind === 'open';
  const mine = !open && spot.slot.memberId === viewerId;
  const isGuest = !open && spot.slot.guestIndex > 0;
  const isMe = mine && !isGuest;

  const className = [
    'pitch-spot',
    onBench ? 'is-bench' : null,
    open ? 'is-open' : null,
    isMe ? 'is-me' : null,
    isGuest ? 'is-guest' : null,
    mine ? 'is-mine' : null,
    isMe && armed ? 'is-armed' : null,
    pending ? 'is-pending' : null,
    !open && recentlyChanged.has(spot.slot.memberId) ? 'flash' : null,
  ]
    .filter(Boolean)
    .join(' ');

  // The stagger is ordered across the field. Keyed by identity rather than by
  // position, so a reconnect reconciles in place and nothing re-deals.
  const style = { '--deal': index } as CSSProperties;

  /*
   * A player item, not a counter.
   *
   * The squad screen is a grid of cards — a face above a name — and that shape
   * is most of what makes a pitch full of people read as a team sheet rather
   * than as dots. A guest takes their bringer's name at a lighter weight, which
   * is the convention the team board already uses for the same reason.
   */
  const inside = (
    <span className="pitch-card">
      {shirt !== undefined ? <span className="pitch-card-shirt">{shirt}</span> : null}
      <span className="pitch-card-face">
        {!open && !isGuest ? (
          <Avatar
            memberId={spot.slot.memberId}
            name={spot.slot.memberName}
            avatarUpdatedAt={spot.slot.memberAvatarUpdatedAt}
            size={spotSize}
          />
        ) : (
          <span className="pitch-disc">
            {open ? (
              <Icon name="add" size={Math.round(spotSize * 0.42)} />
            ) : (
              <Icon name="person" size={Math.round(spotSize * 0.4)} />
            )}
          </span>
        )}
      </span>
      {/* A guest has no name of their own, and repeating the bringer's on three
          cards in a row reads as a duplicate rather than as a party. The dashed
          card and the label a screen reader gets already say whose they are. */}
      <span className="pitch-card-name truncate" aria-hidden="true">
        {open || isGuest ? '' : spot.slot.memberName}
      </span>
    </span>
  );

  if (open && (canJoin || canMove)) {
    /*
     * Landing on a spot, whether or not you were already out there.
     *
     * The haptic is the same for both because what the hand is being told is
     * the same: you are here now. It is one of only three presses in the app
     * that buzz — this, and giving a spot up — because those are the ones that
     * change what you have promised the group, and they are worth feeling land
     * without looking. See `platform.haptics`.
     */
    const moving = canMove && !onBench;
    return (
      <button
        key={spot.key}
        type="button"
        className={className}
        style={style}
        disabled={busy}
        data-haptic="in"
        onClick={() =>
          moving ? onMove(spot.key, index) : onJoin(spot.key, onBench ? null : index)
        }
        // Every empty spot is the same offer, so only the first is worth
        // announcing — eight identical "Take this spot" is noise, and the
        // caption below already says how many there are.
        {...(isFirstOpen
          ? {
              'aria-label': moving
                ? m.pitch.moveHere
                : onBench
                  ? m.pitch.joinWaitlist
                  : m.pitch.takeSpot,
            }
          : { tabIndex: -1, 'aria-hidden': true })}
      >
        {inside}
      </button>
    );
  }

  if (isMe) {
    return (
      <button
        key={spot.key}
        type="button"
        className={className}
        style={style}
        disabled={busy}
        // Both only once armed. The first press is not a tap-out — it changes
        // nothing yet — and voicing or buzzing it as one would say the spot had
        // been given up when it has not. The ring, the label and the clip
        // already say that a press landed.
        data-sound={armed ? 'tap-out' : undefined}
        data-haptic={armed ? 'out' : undefined}
        aria-label={
          onBench
            ? armed
              ? m.pitch.leaveWaitlistArmed
              : m.pitch.yourWaitlistSpot
            : armed
              ? m.pitch.leaveArmed
              : m.pitch.yourSpot
        }
        onClick={() => (armed ? onLeave(spot.key) : onArm())}
      >
        {inside}
      </button>
    );
  }

  // Everything else is a picture. `role="img"` rather than a bare label,
  // following `FormSquares` — a `<span aria-label>` is not reliably announced.
  return (
    <span
      key={spot.key}
      className={className}
      style={style}
      {...(open
        ? { 'aria-hidden': true }
        : {
            role: 'img',
            'aria-label': mine
              ? m.pitch.yourGuest
              : isGuest
                ? m.pitch.guestSpot(spot.slot.memberName)
                : onBench
                  ? m.pitch.waitingSpot(spot.slot.memberName)
                  : m.pitch.playerSpot(spot.slot.memberName),
          })}
    >
      {inside}
    </span>
  );
}
