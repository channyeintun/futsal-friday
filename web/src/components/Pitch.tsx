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
import { registerForSession, withdrawFromSession } from '../api/sessions.js';
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
 * Registering is `WHERE NOT EXISTS (session_id, member_id)` on the Worker side,
 * so a second tap from somebody already registered is a 200 that changes
 * nothing. If empty spots stayed pressable once you were in, that dead tap
 * would be reachable — and it would toast as though something had happened.
 * Making the spot a `<span>` instead makes the dead tap unrepresentable rather
 * than merely unvisited, and it costs nothing to say: an empty circle has no
 * name, no number and no position on it, so there is no promise to break.
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
  const { m } = useLocale();
  const { session, registrations, registrationOpen, me } = detail;

  /** `armed` is your own spot having been pressed once and asking again. */
  type Phase = 'idle' | 'armed' | 'joining' | 'leaving';
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

  const busy = phase === 'joining' || phase === 'leaving';

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

  return (
    <div className="card pitch-card">
      <h2 className="card-title">{m.pitch.heading}</h2>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div
        className="pitch"
        role="group"
        aria-label={m.pitch.label}
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
          <PitchTurf />
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
              const depth = lines.length > 1 ? line / (lines.length - 1) : 1;
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
                    isFirstOpen: index === firstOpen,
                    viewerId: identity.memberId,
                    canJoin,
                    onBench: false,
                    armed: phase === 'armed',
                    pending: pendingKey === spot.key,
                    busy,
                    spotSize,
                    recentlyChanged,
                    m,
                    onJoin: join,
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
              isFirstOpen: spot.kind === 'open',
              viewerId: identity.memberId,
              canJoin: canWait,
              armed: phase === 'armed',
              pending: pendingKey === spot.key,
              busy,
              spotSize: benchSize,
              onBench: true,
              recentlyChanged,
              m,
              onJoin: join,
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
  isFirstOpen,
  viewerId,
  canJoin,
  armed,
  pending,
  busy,
  spotSize,
  onBench,
  recentlyChanged,
  m,
  onJoin,
  onArm,
  onLeave,
}: {
  spot: Spot;
  index: number;
  isFirstOpen: boolean;
  viewerId: string;
  canJoin: boolean;
  armed: boolean;
  pending: boolean;
  busy: boolean;
  spotSize: number;
  /** Waiting rather than playing, which only changes what the labels say. */
  onBench: boolean;
  recentlyChanged: Set<string>;
  m: ReturnType<typeof useLocale>['m'];
  onJoin(key: string, slot: number | null): void;
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

  if (open && canJoin) {
    return (
      <button
        key={spot.key}
        type="button"
        className={className}
        style={style}
        disabled={busy}
        // The only two presses in the app that buzz are this one and its
        // opposite. Both change what you have promised the group, and both are
        // worth feeling land without looking. See `platform.haptics`.
        data-haptic="in"
        onClick={() => onJoin(spot.key, onBench ? null : index)}
        // Every empty spot is the same offer, so only the first is worth
        // announcing — eight identical "Take this spot" is noise, and the
        // caption below already says how many there are.
        {...(isFirstOpen
          ? { 'aria-label': onBench ? m.pitch.joinWaitlist : m.pitch.takeSpot }
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
