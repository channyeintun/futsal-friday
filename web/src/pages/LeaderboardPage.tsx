import { useMemo, useState } from 'react';
import type { LeaderboardRow } from '../api/members.js';
import { Avatar } from '../components/Avatar.js';
import { TopPlayers } from '../components/TopPlayers.js';
import { VirtualList } from '../components/VirtualList.js';
import { Button, ErrorBanner, Spinner } from '../components/ui.js';
import { useLeaderboard } from '../hooks/queries.js';
import { navigate } from '../router.js';
import { useApp } from '../state/app.js';
import { useMessages } from '../state/locale.js';

type Board = 'streak' | 'goals' | 'mvp';

/**
 * Two rankings: who keeps turning up, and who keeps scoring.
 *
 * Kept as two boards rather than one table with two columns, because they are
 * two different arguments. Sorting by goals and showing streaks beside them
 * would imply the streak is a tiebreak, and the person with a long run and no
 * goals would read as losing at something they are winning at.
 *
 * A streak cannot be computed in SQL — it is "how many in a row, counting back
 * from the newest" — so the server does it with the same function the profile
 * uses and sorts before paging, which is what stops a page boundary reordering
 * anybody. See `loadLeaderboard`.
 */
export function LeaderboardPage() {
  const { identity } = useApp();
  const m = useMessages();
  const [board, setBoard] = useState<Board>('streak');

  const query = useLeaderboard(board);
  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
  );

  return (
    <div className="card">
      <h2 className="card-title">{m.board.title}</h2>

      <div className="board-switch">
        {(['streak', 'goals', 'mvp'] as const).map((choice) => (
          <Button
            key={choice}
            variant={choice === board ? 'filled' : 'outlined'}
            onClick={() => setBoard(choice)}
          >
            {choice === 'streak'
              ? m.board.streaks
              : choice === 'goals'
                ? m.board.goals
                : m.board.mvps}
          </Button>
        ))}
      </div>

      <p className="card-sub">
        {board === 'streak'
          ? m.board.streakBody
          : board === 'goals'
            ? m.board.goalsBody
            : m.board.mvpBody}
      </p>

      {query.error ? <ErrorBanner>{query.error.message}</ErrorBanner> : null}
      {query.isPending ? <Spinner label={m.board.loading} /> : null}

      {/* The podium above the table. The table still holds everybody — this is
          the part you can read without reading. */}
      <TopPlayers rows={rows} board={board} viewerId={identity.memberId} />

      <VirtualList
        query={query}
        items={rows}
        estimateSize={58}
        itemKey={(row) => row.member.id}
        empty={
          <p className="empty">
            {board === 'streak'
              ? m.board.nobodyYet
              : board === 'goals'
                ? m.board.noGoalsYet
                : m.board.noMvpsYet}
          </p>
        }
        renderItem={(row: LeaderboardRow) => (
          <div
            className={`player-row${row.member.id === identity.memberId ? ' is-me' : ''}`}
          >
            {/* The top three get the accent. A ranking nobody can read at a
                glance is just a table with numbers down the side. */}
            <span className={`rank-cell${row.rank <= 3 ? ' is-podium' : ''}`}>{row.rank}</span>
            <Avatar
              memberId={row.member.id}
              name={row.member.name}
              avatarUpdatedAt={row.member.avatarUpdatedAt}
              size={28}
            />
            <button
              type="button"
              className="player-name truncate grow link"
              onClick={() => navigate({ name: 'profile', id: row.member.id })}
            >
              {row.member.name}
            </button>
            {row.member.id === identity.memberId ? (
              <span className="badge paid">{m.board.you}</span>
            ) : null}
            {board === 'streak' ? (
              <>
                <span className="muted" style={{ fontSize: '0.72rem' }}>
                  {m.board.bestEver(row.streak.best)}
                </span>
                <span className="board-value">{row.streak.current}</span>
              </>
            ) : board === 'goals' ? (
              <span className="board-value">{row.goals}</span>
            ) : (
              /* The trophy beside the count, so the board reads as awards
                 rather than as another column of numbers. */
              <span className="board-value">🏆 {row.mvps}</span>
            )}
          </div>
        )}
      />
    </div>
  );
}
