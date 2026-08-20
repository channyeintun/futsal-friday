import type { LeaderboardRow } from '../api/members.js';
import { Avatar } from './Avatar.js';
import { ItemCard } from './ItemCard.js';
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
        {top.map((row) => {
          const value = valueOf(row, board);
          const width = row.rank === 1 ? 108 : 96;
          return (
            <button
              key={row.member.id}
              type="button"
              className="fc-card"
              style={{ order: row.rank === 1 ? 2 : row.rank === 2 ? 1 : 3 }}
              onClick={() => navigate({ name: 'profile', id: row.member.id })}
            >
              <ItemCard
                width={width}
                metal={row.rank === 1 ? 'gold' : row.rank === 2 ? 'silver' : 'bronze'}
                /* A rank-2 card can legitimately be on nothing — the podium
                   only bails when the *winner* is on zero — and a big 0 reads
                   as a broken card rather than as a true one. */
                rating={value === 0 ? '—' : value}
                code={code}
                name={row.member.name}
                isMe={row.member.id === viewerId}
                portrait={
                  <Avatar
                    memberId={row.member.id}
                    name={row.member.name}
                    avatarUpdatedAt={row.member.avatarUpdatedAt}
                    size={width}
                    tinted={false}
                    initialsScale={0.26}
                  />
                }
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** The one number this board is about. */
function valueOf(row: LeaderboardRow, board: 'streak' | 'goals' | 'mvp'): number {
  return board === 'streak' ? row.streak.current : board === 'goals' ? row.goals : row.mvps;
}
