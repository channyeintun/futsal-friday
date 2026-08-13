import { useEffect, useRef } from 'react';

/**
 * Scroll an expanding card up under the header, frame by frame.
 *
 * The room to scroll into is exactly what the card's own growth creates, so
 * scrolling once at the start falls short by however much the card has left to
 * grow. Observing the card's size instead re-runs it on every frame of the
 * transition, which makes the growing and the scrolling one movement — and
 * because the expanded height is the gap between the two bars, the two finish
 * together with the list filling that gap exactly.
 *
 * Collapsing needs no counterpart: the page shortens under a scroll position
 * the browser is already clamping, so the cards above slide back into view on
 * their own.
 *
 * A hook rather than an effect in one page because there are two of these now
 * — the fixture history and the debt list — and the fiddly part is exactly the
 * part that gets subtly different when it is copied.
 */
export function useExpandPin<T extends HTMLElement>(expanded: boolean) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const card = ref.current;
    if (!expanded || !card) return;

    // `scroll-margin-top` on the card is what keeps this clear of the sticky
    // header rather than tucked behind it.
    const pin = () => card.scrollIntoView({ block: 'start' });
    pin();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(pin);
    observer.observe(card);
    return () => observer.disconnect();
  }, [expanded]);

  return ref;
}
