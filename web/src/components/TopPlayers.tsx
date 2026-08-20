import type { LeaderboardRow } from '../api/members.js';
import { Avatar } from './Avatar.js';
import { navigate } from '../router.js';
import { useMessages } from '../state/locale.js';

/**
 * The podium, as player items.
 *
 * A leaderboard is a table, and a table is the one shape that makes three
 * different people look like three rows of the same number. The game answers
 * this with a card — a rating in the corner, a face, a name across the bottom —
 * and it works because you read the *item* before you read the figure.
 *
 * Gold, silver and bronze are not decoration here either: those are exactly the
 * tiers a player item comes in, so first, second and third already have a
 * vocabulary waiting for them.
 *
 * Three, and only from the top of the list. A fourth card would make it a grid,
 * and a grid is a table again.
 */
export function TopPlayers({
  rows,
  board,
  viewerId,
}: {
  rows: LeaderboardRow[];
  board: 'streak' | 'goals' | 'mvp';
  viewerId: string;
}) {
  const m = useMessages();
  const top = rows.slice(0, 3);
  // Nothing to put on a podium until somebody has actually done the thing.
  if (top.length === 0 || valueOf(top[0]!, board) === 0) return null;

  const code =
    board === 'streak' ? m.board.codeStreak : board === 'goals' ? m.board.codeGoals : m.board.codeMvp;

  return (
    <section className="top-players">
      <h3 className="top-players-title">{m.board.topPlayers}</h3>
      {/*
        Second, first, third — the shape of a real podium, so the winner is in
        the middle and tallest rather than merely first in reading order. The
        DOM keeps rank order for a screen reader; only the visual order moves.
      */}
      <div className="top-players-row">
        {top.map((row) => (
          <button
            key={row.member.id}
            type="button"
            className={`fc-card is-rank-${row.rank}${row.member.id === viewerId ? ' is-me' : ''}`}
            style={{ order: row.rank === 1 ? 2 : row.rank === 2 ? 1 : 3 }}
            onClick={() => navigate({ name: 'profile', id: row.member.id })}
          >
            <span className="fc-card-rating">
              <strong>{valueOf(row, board)}</strong>
              <small>{code}</small>
            </span>
            <span className="fc-card-face">
              {/* Sized to the card it is standing in, so the portrait meets both
                  edges exactly rather than sitting inside them as a disc. The
                  two figures are the flex bases in `.fc-card`; first is wider
                  because a podium's middle step is. */}
              <Avatar
                memberId={row.member.id}
                name={row.member.name}
                avatarUpdatedAt={row.member.avatarUpdatedAt}
                size={row.rank === 1 ? 108 : 96}
                tinted={false}
              />
            </span>
            <span className="fc-card-name truncate">{row.member.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** The one number this board is about. */
function valueOf(row: LeaderboardRow, board: 'streak' | 'goals' | 'mvp'): number {
  return board === 'streak' ? row.streak.current : board === 'goals' ? row.goals : row.mvps;
}
