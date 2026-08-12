import type { UseInfiniteQueryResult } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useEffect, useRef } from 'react';
import { Spinner } from './ui.js';

/**
 * A long list that neither downloads nor renders all of itself.
 *
 * Both halves matter and neither is enough alone: virtualizing a list you have
 * already fetched still pays for the fetch, and paging one you render in full
 * still pays for the DOM. So this takes an infinite query and does the two
 * together — a window of rows in the document, and the next page requested
 * only when the bottom of what is loaded comes into view.
 *
 * Extracted rather than repeated because there are three of these — the
 * roster, the debt list, and the fixture history — and the fiddly parts
 * (measuring rows that wrap, not firing a fetch while one is in flight,
 * scrolling inside a box rather than the page) are exactly the parts that get
 * subtly different when they are copied.
 */
export function VirtualList<T>({
  query,
  items,
  estimateSize = 64,
  renderItem,
  itemKey,
  empty,
  endNote,
}: {
  query: Pick<
    UseInfiniteQueryResult<unknown>,
    'hasNextPage' | 'isFetchingNextPage' | 'fetchNextPage'
  >;
  /** Every row loaded so far, already flattened out of the pages. */
  items: readonly T[];
  /** Starting row height. Rows re-measure themselves, so this is only a hint. */
  estimateSize?: number;
  renderItem: (item: T, index: number) => ReactNode;
  itemKey: (item: T, index: number) => string;
  empty?: ReactNode;
  /** Shown under the list once there is nothing left to fetch. */
  endNote?: ReactNode;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    // One row past the end while more is coming: that slot renders a spinner
    // and doubles as the "you have reached the bottom" signal below.
    count: query.hasNextPage ? items.length + 1 : items.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => estimateSize,
    overscan: 6,
  });

  const rows = virtualizer.getVirtualItems();
  const last = rows.at(-1);

  // Triggered by the placeholder becoming visible rather than by a scroll
  // offset: it works the same whatever the rows turn out to measure, and it
  // cannot fire early on a short list that has no next page.
  useEffect(() => {
    if (!last || last.index < items.length) return;
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    void query.fetchNextPage();
  }, [last, items.length, query]);

  if (items.length === 0 && !query.hasNextPage) return <>{empty}</>;

  return (
    <>
      <div ref={scrollerRef} className="virtual-scroller">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {rows.map((row) => {
            const item = items[row.index];
            return (
              <div
                key={item ? itemKey(item, row.index) : 'loading'}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="virtual-row"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {item ? (
                  renderItem(item, row.index)
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
      {!query.hasNextPage && items.length > 0 && endNote ? endNote : null}
    </>
  );
}
