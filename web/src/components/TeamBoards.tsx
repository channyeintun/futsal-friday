import {
  type SessionDetail,
  type TeamDraw,
  type TeamMatch,
  MIN_TEAMS,
  TEAM_LETTERS,
  arrivedSlots,
  balancedSizes,
  canRedrawTeams,
  matchPlayed,
  maxTeamsFor,
  relativeToNow,
  slotKey,
  slotsMissingFrom,
  teamRecords,
} from '@futsal/shared';
import { useEffect, useRef, useState } from 'react';
import {
  addLatecomers,
  clearSessionTeams,
  confirmSessionTeams,
  drawSessionTeams,
  recordMatch,
} from '../api/sessions.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Avatar } from './Avatar.js';
import { PackOpening } from './PackOpening.js';
import { Icon } from './Icon.js';
import { Button, Dialog, ErrorBanner } from './ui.js';

/** A scoreline past this is a typo, and the stepper should not help you type it. */
const MAX_MATCH_GOALS = 30;

/**
 * Picking sides, and the games that follow.
 *
 * Everybody is standing on the pitch, somebody gets their phone out, and two
 * or three teams have to exist within about a minute. The screen is built for
 * that minute: one question (how many), one button, and a board big enough to
 * read at arm's length while holding a ball.
 *
 * ## Why the shuffle is loud
 *
 * The animation is not decoration. A random draw is only useful if the group
 * accepts it, and a board that simply blinks from one arrangement to another
 * looks like somebody edited it. Dealing the names out one at a time, in front
 * of everyone, is the part that makes a reshuffle read as another draw rather
 * than as an argument being won — which is what lets anybody press the button
 * again without it being a challenge to whoever pressed it last.
 *
 * ## Why there is a confirm step
 *
 * Reshuffling has to stop being everybody's business at some point, and that
 * point is when people put bibs on. Confirming fixes the sides, hands the
 * redraw to the organizer alone, and puts up the fixture list — so the score
 * of a game that has just finished goes against a line that already exists,
 * and nobody is ever asked at full time who they just played.
 */
export function TeamBoards({
  detail,
  live,
  kickedOff,
  onChanged,
}: {
  detail: SessionDetail;
  /**
   * False once the game is over — see `teamBoardLive`. The card then stops
   * being a set of controls and becomes the record of what happened: who was
   * on which side, and how each game finished.
   */
  live: boolean;
  /**
   * Whether the game has started. Only the wording turns on this — before
   * kickoff the roster is who is *in*, and telling somebody to mark who turned
   * up is instructions for a game that has not happened.
   */
  kickedOff: boolean;
  onChanged(): void;
}) {
  const { identity } = useApp();
  const { m, locale } = useLocale();
  const draw = detail.teams;

  const [asking, setAsking] = useState(false);
  const [choice, setChoice] = useState(MIN_TEAMS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * The fixture being scored is held by *id*, and looked up in the live board
   * on every render rather than snapshotted when the dialog opened.
   *
   * Somebody else can redraw or clear the teams while this dialog is up, and
   * the new board arrives over the realtime channel. Holding the match object
   * would leave the dialog editing a fixture that no longer exists, and the
   * save would fail with a 404 after the numbers had been typed in. This way
   * the dialog simply goes when its game does.
   */
  const [scoringId, setScoringId] = useState<string | null>(null);
  /*
   * Separate from `busy`, which every action on this card sets.
   *
   * The board stepping back is a promise that it is about to be replaced, and
   * that is only true of a draw. Dimming it while somebody types a scoreline
   * into a dialog would say the teams were changing when they are not.
   */
  const [dealing, setDealing] = useState(false);

  /*
   * Whether to open the draw rather than simply show it.
   *
   * Keyed on `drawnAt` changing *while this is mounted*, which is exactly the
   * set of people looking at the session when somebody shuffles — the group
   * standing on the pitch. The ref starts at whatever was already there, so
   * arriving at a session that was drawn an hour ago shows the board and no
   * ceremony: a reveal of old news is a cutscene, not an event.
   */
  const seenDraw = useRef(draw?.drawnAt ?? null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    const at = draw?.drawnAt ?? null;
    if (at === seenDraw.current) return;
    const first = seenDraw.current === null && at !== null;
    seenDraw.current = at;
    // A draw appearing where there was none is still news — somebody pressed
    // shuffle for the first time — but only if it is this session's first draw
    // and not the page catching up on one it was never watching.
    if (at !== null && (!first || justNow(at))) setOpening(true);
  }, [draw?.drawnAt]);

  // Who is on the pitch right now, by the same rules the bill uses. The draw
  // is a snapshot of this, not a view of it — see `slotsMissingFrom`.
  const slots = arrivedSlots(detail.registrations);
  const headroom = maxTeamsFor(slots.length);
  const missing = draw ? slotsMissingFrom(draw, slots) : [];
  const settled = draw?.confirmedAt != null;
  const mayRedraw = live && canRedrawTeams(draw, identity);
  /*
   * Correcting a score after the fact stays possible, for the organizer only.
   *
   * Everything else about a finished board is frozen, but a scoreline typed
   * into the wrong game is exactly the mistake that gets noticed on the drive
   * home — and this app has an answer for that everywhere else it stores an
   * after-the-fact fact: anybody may say, and the organizer may correct. A
   * record nobody can fix is not a better record.
   */
  const mayScore = live || identity.isOrganizer;
  const records = draw ? teamRecords(draw.teamCount, draw.matches) : [];
  const anyPlayed = draw?.matches.some(matchPlayed) ?? false;
  const scoring = draw?.matches.find((match) => match.id === scoringId) ?? null;
  /*
   * Enough people left to field the sides.
   *
   * Not the same question as "is there a draw": people get marked absent after
   * one, and a board of ten can be a pitch of one by the time somebody presses
   * shuffle. Without this the how-many dialog opens with no options to pick.
   */
  const canSplit = headroom >= MIN_TEAMS;

  /** Every mutation here is the same shape: try, surface, refresh. */
  const run = async (action: () => Promise<unknown>, fallback: string, done?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      done?.();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const ask = () => {
    setChoice(Math.min(Math.max(draw?.teamCount ?? MIN_TEAMS, MIN_TEAMS), headroom));
    setError(null);
    setAsking(true);
  };

  /** Deal, with the board dimmed for the round trip. */
  const deal = async () => {
    setDealing(true);
    try {
      await run(() => drawSessionTeams(detail.session.id, choice), m.teams.failed, () =>
        setAsking(false),
      );
    } finally {
      setDealing(false);
    }
  };

  /* Backing out of a dialog takes its complaint with it, rather than leaving
     it stranded on the card where it no longer has any context. */
  const closeDialogs = () => {
    setAsking(false);
    setScoringId(null);
    setError(null);
  };

  return (
    <div className="card">
      {opening && draw ? (
        <PackOpening draw={draw} onDone={() => setOpening(false)} />
      ) : null}

      <div className="row between">
        <h2 className="card-title">{m.teams.title}</h2>
        {draw ? <span className="muted">{m.teams.teamSize(draw.teams.flat().length)}</span> : null}
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {draw ? (
        <>
          {/*
            Keyed on the draw's timestamp so a new draw is a new subtree: the
            deal-in animation is declared once in CSS and replays because the
            elements are genuinely new, rather than being restarted by hand.
          */}
          <div key={draw.drawnAt} className={`team-boards${dealing ? ' is-dealing' : ''}`}>
            {draw.teams.map((team, teamIndex) => (
              <section className="team-board" key={teamIndex}>
                <header className={`team-head team-${teamIndex + 1}`}>
                  <span className="team-dot" />
                  <span className="team-name">
                    {m.teams.teamName(TEAM_LETTERS[teamIndex] ?? String(teamIndex + 1))}
                  </span>
                  <span className="team-count">{team.length}</span>
                </header>

                {/* Only once there is a result to report. Three zeroes on a
                    board nobody has played on is noise. */}
                {anyPlayed && records[teamIndex] ? (
                  <p className="team-record">
                    {m.teams.record(
                      records[teamIndex]!.won,
                      records[teamIndex]!.drawn,
                      records[teamIndex]!.lost,
                    )}
                  </p>
                ) : null}

                {team.length === 0 ? (
                  <p className="empty">{m.teams.empty}</p>
                ) : (
                  <ul className="team-list">
                    {team.map((slot, row) => (
                      <li
                        key={slotKey(slot)}
                        className={[
                          'team-slot',
                          slot.guestIndex > 0 ? 'is-guest' : '',
                          slot.guestIndex === 0 && slot.memberId === identity.memberId
                            ? 'is-me'
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        /*
                          Dealt across the board rather than down each column:
                          one to team A, one to team B, one to team A. Cards
                          are dealt that way, and it is what makes the stagger
                          read as a draw being made instead of two lists
                          loading side by side.
                        */
                        style={
                          { '--deal': row * draw.teamCount + teamIndex } as React.CSSProperties
                        }
                      >
                        {slot.guestIndex === 0 ? (
                          <Avatar
                            memberId={slot.memberId}
                            name={slot.memberName}
                            avatarUpdatedAt={slot.memberAvatarUpdatedAt}
                            size={24}
                          />
                        ) : (
                          <span className="team-guest" aria-hidden="true">
                            <Icon name="person" size={14} />
                          </span>
                        )}
                        <span className="team-player truncate">{slot.memberName}</span>
                        {/*
                          The dashed circle carries this, not a chip.
                          Measured at 430px with three teams up: a "guest"
                          badge beside the name left the name 4rem and
                          truncated "Bo Bo" to "Bo …", which loses the only
                          thing the row is for. The greyed name and the broken
                          outline say the same thing and cost no width.
                        */}
                        {slot.guestIndex > 0 ? (
                          <span className="sr-only">{m.teams.guest}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>

          {/* Whose draw this is. Most of what settles "who decided that?". */}
          <p className="muted" style={{ margin: 0 }}>
            {settled && draw.confirmedBy
              ? m.teams.settledBy(
                  draw.confirmedBy.memberName,
                  relativeToNow(draw.confirmedAt!, new Date(), locale),
                )
              : draw.drawnBy
                ? m.teams.drawnBy(
                    draw.drawnBy.memberName,
                    relativeToNow(draw.drawnAt, new Date(), locale),
                  )
                : null}
          </p>

          {/*
            Said loudest exactly when it used to be hidden.

            This was gated on `!settled`, which suppressed it in the one case
            that matters: the board opens days before kickoff and registration
            runs through the game itself, so teams settled on Tuesday and two
            more people on Thursday — or at 19:35 — is ordinary. Silently
            leaving them off, with only a full redraw, which destroys the
            fixtures and their scores, to put it right, was the worst of both.
          */}
          {live && missing.length > 0 ? (
            <div className="attend-note">
              <p style={{ margin: 0 }}>{m.teams.missing(missing.length)}</p>
              <Button
                variant="tonal"
                onClick={() =>
                  void run(() => addLatecomers(detail.session.id), m.teams.failed)
                }
                disabled={busy}
              >
                <Icon name="person" size={18} slot="icon" />
                {m.teams.dealThemIn(missing.length)}
              </Button>
            </div>
          ) : null}

          {settled ? (
            <MatchList
              draw={draw}
              live={live}
              editable={mayScore}
              onPick={(match) => {
                setError(null);
                setScoringId(match.id);
              }}
            />
          ) : live ? (
            <p className="muted" style={{ margin: 0 }}>
              {m.teams.confirmHint}
            </p>
          ) : (
            /* Drawn and never settled — the group put bibs on and nobody
               tapped the button. Said as a thing still to do, because it is:
               the confirmation below outlives the game. */
            <p className="muted" style={{ margin: 0 }}>
              {m.teams.neverSettled}
            </p>
          )}

          {mayRedraw ? (
            <div className="row" style={{ gap: 8 }}>
              <div className="grow">
                {/* Shuffling needs enough people to fill two sides, and the
                    roster moves after a draw — somebody marked absent can take
                    the pitch below that. Clearing is still offered, because
                    that is the only thing left worth doing. */}
                <Button variant="tonal" onClick={ask} disabled={busy || !canSplit}>
                  <Icon name="tune" size={18} slot="icon" />
                  {busy ? m.teams.dealing : m.teams.shuffle}
                </Button>
              </div>
              <Button
                variant="text"
                danger
                onClick={() => void run(() => clearSessionTeams(detail.session.id), m.teams.failed)}
                disabled={busy}
              >
                {m.teams.clear}
              </Button>
            </div>
          ) : live ? (
            <p className="muted" style={{ margin: 0 }}>
              {m.teams.locked}
            </p>
          ) : null}

          {/*
            Offered for as long as the sides are unsettled, including after
            the board has otherwise become a record.

            This used to close with the rest of the card two hours after
            kickoff, which stranded the one group that needed it: everybody
            who splits teams and forgets to tap this. Their sides could then
            never hold a game — confirming is what writes the fixture list —
            and nothing on the screen could put it right.

            Nothing about a late confirmation is destructive. Shuffling and
            clearing stay shut because they throw work away; this only turns
            a draw into a record, and the server never gated it by time in
            the first place.
          */}
          {!settled ? (
            <Button
              variant="filled"
              onClick={() => void run(() => confirmSessionTeams(detail.session.id), m.teams.failed)}
              disabled={busy}
            >
              <Icon name="check" size={18} slot="icon" />
              {m.teams.confirm}
            </Button>
          ) : null}
        </>
      ) : !canSplit ? (
        <p className="empty">{kickedOff ? m.teams.nobodyYet : m.teams.notEnoughYet}</p>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>
            {kickedOff ? m.teams.body : m.teams.bodyBefore}
          </p>
          <Button variant="filled" onClick={ask} disabled={busy}>
            <Icon name="tune" size={18} slot="icon" />
            {busy ? m.teams.dealing : m.teams.split}
          </Button>
        </>
      )}

      <HowManyDialog
        open={asking}
        heads={slots.length}
        maxTeams={headroom}
        choice={choice}
        busy={busy}
        error={error}
        warnLosingResults={settled}
        onChoose={setChoice}
        onClose={closeDialogs}
        onDeal={() => void deal()}
      />

      {scoring ? (
        <ScoreDialog
          // A fresh instance per fixture, so the steppers never open showing
          // the previous game's score.
          key={scoring.id}
          match={scoring}
          busy={busy}
          error={error}
          onClose={closeDialogs}
          onSave={(firstGoals, secondGoals) =>
            void run(
              () => recordMatch(detail.session.id, scoring.id, { firstGoals, secondGoals }),
              m.teams.scoreFailed,
              () => setScoringId(null),
            )
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The fixture list.
 *
 * Every pairing exists from the moment the teams were settled, so a game that
 * has just finished is a row waiting for two numbers rather than a form asking
 * who played whom. Tapping a row is the only way in — the whole list is
 * editable, because a score typed in the wrong box is noticed by whoever lost.
 */
function MatchList({
  draw,
  live,
  editable,
  onPick,
}: {
  draw: TeamDraw;
  /**
   * Whether games are still being played. Separate from `editable`, which is
   * about permission: an organizer correcting last week's scoreline may tap
   * these rows, but telling them to put the score in when a game finishes is
   * instructions for a game that finished days ago.
   */
  live: boolean;
  /** False on a finished board nobody may correct: rows become plain text. */
  editable: boolean;
  onPick(match: TeamMatch): void;
}) {
  const { m } = useLocale();
  if (draw.matches.length === 0) return null;

  const name = (index: number) =>
    m.teams.teamName(TEAM_LETTERS[index] ?? String(index + 1));

  return (
    <div className="stack">
      <h3 className="card-sub" style={{ fontWeight: 600 }}>
        {m.teams.matches}
      </h3>
      {live ? (
        <p className="muted" style={{ margin: 0 }}>
          {m.teams.matchesHint}
        </p>
      ) : null}

      <ul className="match-list">
        {draw.matches.map((match) => {
          const played = matchPlayed(match);
          /*
            The score goes in the label, not just in the row.

            An `aria-label` replaces an element's own contents as its
            accessible name, so without the scoreline here every fixture
            announces identically and a finished game is indistinguishable from
            one still to play — which is the only thing this list is for. Same
            reasoning as the form squares.
          */
          const label = `${m.teams.scoreTitle(
            name(match.firstTeam),
            name(match.secondTeam),
          )} — ${played ? `${match.firstGoals} – ${match.secondGoals}` : m.teams.notPlayed}`;

          const contents = (
            <>
              <span className={`team-dot team-${match.firstTeam + 1}`} />
              <span className="match-side truncate">{name(match.firstTeam)}</span>
              <span className={`match-score${played ? '' : ' is-blank'}`}>
                {played ? `${match.firstGoals} – ${match.secondGoals}` : '–'}
              </span>
              <span className="match-side truncate align-end">{name(match.secondTeam)}</span>
              <span className={`team-dot team-${match.secondTeam + 1}`} />
            </>
          );

          return (
            <li key={match.id}>
              {/* A finished game nobody may change is not a control. Rendering
                  it as a button anyway would put a tap target on every row of
                  a record and promise something that does not happen. */}
              {editable ? (
                <button
                  type="button"
                  className="match-row"
                  onClick={() => onPick(match)}
                  aria-label={label}
                >
                  {contents}
                </button>
              ) : (
                <div className="match-row is-static" role="img" aria-label={label}>
                  {contents}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The one question worth asking before dealing.
 *
 * Asked every time, including on a reshuffle. Two teams is the common case but
 * it is not safe to assume it — the group that turns up eighteen strong plays
 * three, and the number is the only thing about the draw anybody gets to
 * choose. The sizes are shown alongside because "11 players" and "4 · 4 · 3"
 * are different facts, and the second one is what changes minds.
 */
function HowManyDialog({
  open,
  heads,
  maxTeams,
  choice,
  busy,
  error,
  warnLosingResults,
  onChoose,
  onClose,
  onDeal,
}: {
  open: boolean;
  heads: number;
  maxTeams: number;
  choice: number;
  busy: boolean;
  error: string | null;
  warnLosingResults: boolean;
  onChoose(count: number): void;
  onClose(): void;
  onDeal(): void;
}) {
  const { m } = useLocale();
  const options = Array.from(
    { length: Math.max(0, maxTeams - MIN_TEAMS + 1) },
    (_, i) => i + MIN_TEAMS,
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      headline={m.teams.howMany}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {m.app.cancel}
          </Button>
          <Button onClick={onDeal} disabled={busy}>
            {busy ? m.teams.dealing : m.teams.deal}
          </Button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        {m.teams.onThePitch(heads)}
      </p>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {/* Said before the tap, not after it. Redrawing a settled board throws
          away the scores, and that is not something to discover afterwards. */}
      {warnLosingResults ? <div className="attend-note">{m.teams.redoWarning}</div> : null}

      {/* Taps, not a keypad. The answer is between two and six, and a numeric
          keyboard for that is three interactions where one will do — the same
          call the guest picker makes for the same reason. */}
      <div className="team-choices">
        {options.map((count) => (
          <button
            key={count}
            type="button"
            className={`team-choice${count === choice ? ' is-chosen' : ''}`}
            onClick={() => onChoose(count)}
            aria-pressed={count === choice}
          >
            {count}
          </button>
        ))}
      </div>

      <p className="muted" style={{ margin: 0 }}>
        {m.teams.willBe(balancedSizes(heads, choice).join(' · '))}
      </p>
    </Dialog>
  );
}

/**
 * How it finished.
 *
 * Two steppers laid out as a scoreline, rather than the row of tap-choices the
 * rest of the app uses for small numbers. Two independent counts with an open
 * top end do not fit that shape — a 0-12 strip twice over is twenty-six
 * targets in a phone dialog — and a scoreboard is the one arrangement of these
 * two numbers everybody can already read.
 */
function ScoreDialog({
  match,
  busy,
  error,
  onClose,
  onSave,
}: {
  match: TeamMatch;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onSave(firstGoals: number | null, secondGoals: number | null): void;
}) {
  const { m } = useLocale();
  const [first, setFirst] = useState(match.firstGoals ?? 0);
  const [second, setSecond] = useState(match.secondGoals ?? 0);

  const name = (index: number) => m.teams.teamName(TEAM_LETTERS[index] ?? String(index + 1));

  return (
    <Dialog
      open
      onClose={onClose}
      headline={m.teams.scoreTitle(name(match.firstTeam), name(match.secondTeam))}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {m.app.cancel}
          </Button>
          <Button onClick={() => onSave(first, second)} disabled={busy}>
            {busy ? m.app.saving : m.app.save}
          </Button>
        </>
      }
    >
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div className="score-entry">
        <GoalStepper
          label={name(match.firstTeam)}
          colourIndex={match.firstTeam}
          value={first}
          onChange={setFirst}
        />
        <span className="score-dash" aria-hidden="true">
          –
        </span>
        <GoalStepper
          label={name(match.secondTeam)}
          colourIndex={match.secondTeam}
          value={second}
          onChange={setSecond}
        />
      </div>

      {/* Putting a fixture back to unplayed is a real answer, not an undo:
          a score entered against the wrong game has to be removable. */}
      {matchPlayed(match) ? (
        <Button variant="text" danger onClick={() => onSave(null, null)} disabled={busy}>
          {m.teams.markNotPlayed}
        </Button>
      ) : null}

      {match.recordedBy ? (
        <p className="muted" style={{ margin: 0 }}>
          {m.teams.scoredBy(match.recordedBy.memberName)}
        </p>
      ) : null}
    </Dialog>
  );
}

function GoalStepper({
  label,
  colourIndex,
  value,
  onChange,
}: {
  label: string;
  colourIndex: number;
  value: number;
  onChange(next: number): void;
}) {
  return (
    <div className={`score-side team-${colourIndex + 1}`}>
      <span className="score-label truncate">{label}</span>
      {/* Both steppers are silent. Entering 5-3 is eight presses in two
          seconds, and eight of the same chime is a machine gun rather than
          feedback. See `platform.sound`. */}
      <div className="score-stepper">
        <button
          type="button"
          className="score-step"
          data-sound="none"
          onClick={() => onChange(Math.max(0, value - 1))}
          disabled={value === 0}
          aria-label={`${label} −1`}
        >
          −
        </button>
        <span className="score-value" aria-live="polite">
          {value}
        </span>
        <button
          type="button"
          className="score-step"
          data-sound="none"
          onClick={() => onChange(Math.min(MAX_MATCH_GOALS, value + 1))}
          disabled={value === MAX_MATCH_GOALS}
          aria-label={`${label} +1`}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * Whether a draw is new enough to be worth opening.
 *
 * The first draw a page ever sees is ambiguous: it is either somebody pressing
 * shuffle a second ago, or a board that has been sitting there since before the
 * app was opened. The timestamp settles it, and generously — a slow phone on a
 * bad connection can take a few seconds to hear about a draw it should still
 * celebrate.
 */
function justNow(at: string): boolean {
  const when = Date.parse(at);
  return Number.isFinite(when) && Date.now() - when < 15_000;
}
