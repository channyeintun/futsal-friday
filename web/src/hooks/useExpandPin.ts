import { useEffect, useRef } from 'react';

/**
 * Scroll an expanding card up under the header as it opens.
 *
 * One call, after the class has landed. `scrollIntoView` forces layout, so by
 * the time it measures, the card is already at its expanded height — there is
 * no growth left to chase.
 *
 * It used to chase it with a `ResizeObserver`, because the height was a 220ms
 * transition and a single scroll at the start fell short of where the card
 * ended up. That transition has gone (see `.list-card` in the stylesheet — it
 * never completed, which is why the cards never opened), and with it the only
 * reason to observe anything.
 *
 * Collapsing needs no counterpart: the page shortens under a scroll position
 * the browser is already clamping, so the cards above slide back into view on
 * their own.
 */
export function useExpandPin<T extends HTMLElement>(expanded: boolean) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const card = ref.current;
    if (!expanded || !card) return;

    // `scroll-margin-top` on the card is what keeps this clear of the sticky
    // header rather than tucked behind it.
    card.scrollIntoView({ block: 'start' });
  }, [expanded]);

  return ref;
}
