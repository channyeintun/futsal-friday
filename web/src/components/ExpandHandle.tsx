import { useMessages } from '../state/locale.js';

/**
 * The grab bar under a list that can take the whole screen.
 *
 * A short notch centred on the card's bottom edge, which is the shape phones
 * have taught everybody means "this panel moves". It replaced a pair of
 * arrow icons in the card's top corner: those read as a control belonging to
 * the heading — something that acts on the list — when the only thing they do
 * is change how much of it you can see. A bar sitting on the edge that moves
 * says that without a word, which is also why it needs no label beside it.
 *
 * It toggles rather than drags. The card has two heights, not a range, and a
 * drag gesture would promise a precision that has nothing to land on.
 */
export function ExpandHandle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle(): void;
}) {
  const m = useMessages();
  const label = expanded ? m.history.collapseList : m.history.expandList;

  return (
    <button
      type="button"
      className="list-handle"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {/* The bar is the whole of what is drawn; the button around it is the
          part you can actually hit with a thumb. */}
      <span className="list-handle-bar" aria-hidden="true" />
    </button>
  );
}
