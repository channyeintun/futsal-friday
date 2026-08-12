import type { FormEntry } from '../api/members.js';
import { useMessages } from '../state/locale.js';

/**
 * A single row of tiny squares: the last few games, oldest on the left.
 *
 * Borrowed from a contribution graph, and it earns the comparison for the same
 * reason that one does — you read a *pattern* at a glance without reading a
 * single number. "Four filled then a gap" says more about somebody's run than
 * "streak: 0" does, because it also says they were here until last week.
 *
 * One row, not a grid: this sits at the end of a name in a list on a phone,
 * where the whole thing gets about forty pixels of height and any second row
 * would push the name off its line.
 *
 * Deliberately not a link or a button. It is a glance, and the name beside it
 * already goes to the profile where the full record is; making the squares
 * tappable would put two targets in one row that lead to the same place.
 */
export function FormSquares({ recent }: { recent: FormEntry['recent'] }) {
  const m = useMessages();
  if (recent.length === 0) return null;

  const played = recent.filter((r) => r === 'in').length;

  return (
    <span
      className="form-squares"
      // The row is decorative on its own; the label is what a screen reader
      // gets, because eight unlabelled squares are noise to anyone not
      // looking at them.
      role="img"
      aria-label={m.form.label(played, recent.length)}
      title={m.form.label(played, recent.length)}
    >
      {recent.map((outcome, index) => (
        <span
          // Position in the window is the identity here: these are slots, not
          // records, and slot three is always the third-oldest game.
          key={index}
          className={`form-square is-${outcome}`}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
