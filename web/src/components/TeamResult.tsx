import { TEAM_LETTERS, type MatchOutcome } from '@futsal/shared';
import { useMessages } from '../state/locale.js';

/**
 * Which side you were on that week, and how its games went.
 *
 * A team name and a row of tiny marks, sized and shaped like the form squares
 * beside a name on the session list — deliberately, because it is the same
 * kind of fact read the same way. You scan a column of history and see a run
 * of green without reading a single number, and "which team" is a colour
 * rather than a word competing with the venue for the line.
 *
 * Nothing here is a link. The row it sits in already goes to the session,
 * where the full board is; a second target would lead to the same place.
 */
export function TeamResult({
  team,
  outcomes,
}: {
  team: number;
  outcomes: readonly MatchOutcome[];
}) {
  const m = useMessages();

  const won = outcomes.filter((o) => o === 'won').length;
  const drawn = outcomes.filter((o) => o === 'drawn').length;
  const lost = outcomes.filter((o) => o === 'lost').length;
  const name = m.teams.teamName(TEAM_LETTERS[team] ?? String(team + 1));

  return (
    <span className="team-result">
      <span className={`team-dot team-${team + 1}`} aria-hidden="true" />
      <span className={`team-result-name team-${team + 1}`}>{name}</span>

      {/* The marks are decorative on their own — the label is what carries the
          record to anyone not looking at them. */}
      {outcomes.length > 0 ? (
        <span
          className="result-marks"
          role="img"
          aria-label={m.teams.record(won, drawn, lost)}
          title={m.teams.record(won, drawn, lost)}
        >
          {outcomes.map((outcome, index) => (
            // Position is the identity: these are that afternoon's games in
            // the order they were listed, not records with ids of their own.
            <span key={index} className={`result-mark is-${outcome}`} aria-hidden="true" />
          ))}
        </span>
      ) : null}
    </span>
  );
}
