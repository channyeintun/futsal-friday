import type { Member } from '@futsal/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { removeMember, updateMember } from '../api/members.js';
import { Avatar } from '../components/Avatar.js';
import { ConfirmButton } from '../components/ConfirmButton.js';
import { Icon } from '../components/Icon.js';
import { MemberInviteControls } from '../components/InviteLink.js';
import { Button, ErrorBanner, Spinner, Switch } from '../components/ui.js';
import { useMembersCount, useMembersInfinite } from '../hooks/queries.js';
import { useApp } from '../state/app.js';
import { useMessages } from '../state/locale.js';

/**
 * Everybody in the group, on a screen of their own.
 *
 * This used to be a card on Setup, which put every player between the
 * organizer and the controls underneath — adding a midweek fixture or signing
 * out meant scrolling past the whole roster to reach them. Setup now shows a
 * count and a way in; the list itself lives here, where being long is fine.
 *
 * ## Why it is virtualized
 *
 * Each row carries an avatar, a switch and two dialogs' worth of controls, so
 * a hundred of them is a few thousand nodes and a switch component per player
 * whether or not anybody scrolls that far. The virtualizer keeps the DOM at
 * roughly what fits on screen, and the infinite query means the *data* arrives
 * in pages to match — neither is much use without the other, since rendering
 * ten rows out of a thousand you already downloaded still costs the download.
 */
export function PlayersPage() {
  const { toast, refresh } = useApp();
  const m = useMessages();
  const [error, setError] = useState<string | null>(null);

  const roster = useMembersInfinite();
  // The header counts everybody, not the pages fetched so far — "Players (50)"
  // while scrolling through two hundred of them is a lie that corrects itself
  // as you scroll, which is worse than no number.
  const total = useMembersCount();

  // Pages flattened once per fetch rather than on every render: the
  // virtualizer reads this on each scroll frame.
  const members = useMemo(
    () => roster.data?.pages.flatMap((page) => page.members) ?? [],
    [roster.data],
  );

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    // One past the end while more is coming, so the last slot renders a
    // spinner and the observer below has something to notice.
    count: roster.hasNextPage ? members.length + 1 : members.length,
    getScrollElement: () => scrollerRef.current,
    // A measured guess; rows re-measure themselves through `measureElement`,
    // which matters because a long name wraps to two lines in Burmese.
    estimateSize: () => 76,
    overscan: 6,
  });

  const items = virtualizer.getVirtualItems();
  const last = items.at(-1);

  // Fetch the next page when the placeholder row comes into view, rather than
  // on a scroll-position threshold: the placeholder *is* the "you have reached
  // the end" signal, and it works the same whatever the row height turns out
  // to be.
  useEffect(() => {
    if (!last) return;
    if (last.index < members.length) return;
    if (!roster.hasNextPage || roster.isFetchingNextPage) return;
    void roster.fetchNextPage();
  }, [last, members.length, roster]);

  const toggleOrganizer = async (member: Member) => {
    try {
      await updateMember(member.id, { isOrganizer: !member.isOrganizer });
      await roster.refetch();
      // The caller may have just changed their own role.
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.admin.couldNotChange);
    }
  };

  const remove = async (member: Member) => {
    try {
      await removeMember(member.id);
      toast(m.toast.memberRemoved(member.name));
      await roster.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.admin.couldNotRemove);
    }
  };

  if (roster.isPending) return <Spinner label={m.admin.loadingPlayers} />;
  if (roster.error) return <ErrorBanner>{roster.error.message}</ErrorBanner>;

  return (
    <div className="card">
      <h2 className="card-title">{m.admin.players(total.data ?? members.length)}</h2>
      <p className="card-sub">{m.admin.removeNote}</p>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {/*
        The scroller is this element, not the page. A virtualizer needs a box
        with a known height to measure against, and `dvh` rather than `vh`
        because on a phone `vh` resolves to the tall viewport you only have
        once the address bar has gone — sized against that, the bottom of the
        list sits under the nav bar.
      */}
      <div ref={scrollerRef} className="virtual-scroller">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((row) => {
            const member = members[row.index];
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="virtual-row"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {member ? (
                  <div className="member-row">
                    <div className="row" style={{ gap: 8 }}>
                      <Avatar
                        memberId={member.id}
                        name={member.name}
                        avatarUpdatedAt={member.avatarUpdatedAt}
                        size={32}
                      />
                      <span className="player-name truncate grow">{member.name}</span>
                      <span className="muted" style={{ fontSize: '0.75rem' }}>
                        {m.app.organizerSuffix}
                      </span>
                      <Switch
                        selected={member.isOrganizer}
                        onChange={() => toggleOrganizer(member)}
                      />
                    </div>
                    <div className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <MemberInviteControls member={member} onChanged={() => void roster.refetch()} />
                      {/* Separated from the sign-out control beside it: the two
                          are both destructive and were indistinguishable. */}
                      <span className="control-divider" aria-hidden="true" />
                      <ConfirmButton
                        ariaLabel={m.app.remove}
                        headline={m.admin.confirmRemoveMember(member.name)}
                        body={m.admin.confirmRemoveMemberBody}
                        confirmLabel={m.app.remove}
                        onConfirm={() => remove(member)}
                      >
                        <Icon name="close" size={16} />
                      </ConfirmButton>
                    </div>
                  </div>
                ) : (
                  <div className="row" style={{ justifyContent: 'center', padding: 12 }}>
                    <Spinner />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {!roster.hasNextPage && members.length > 0 ? (
        <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
          {m.admin.thatIsEveryone}
        </p>
      ) : null}

      <Button variant="text" onClick={() => void roster.refetch()}>
        {m.admin.refreshPlayers}
      </Button>
    </div>
  );
}
