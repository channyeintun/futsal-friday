/**
 * Initials for the avatar fallback.
 *
 * In /shared rather than next to the component because it is pure, and because
 * getting it right is a *script* problem rather than a rendering one: naive
 * `name[0]` is fine for Latin and wrong for most of the writing systems this
 * app actually serves.
 */

/**
 * Up to two letters, one per name part.
 *
 * Burmese writes a syllable as a base consonant plus marks that attach above,
 * below and around it — ကျွန် is one thing a reader would call a character but
 * five code units. Slicing by index leaves an orphaned diacritic, which
 * renders as a dotted circle. `Intl.Segmenter` splits where a reader would.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map(firstGrapheme).join('');
}

function firstGrapheme(word: string): string {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      .segment(word)
      [Symbol.iterator]()
      .next();
    if (!first.done) return first.value.segment.toLocaleUpperCase();
  }
  // Code points rather than code units, so at least an emoji or a surrogate
  // pair survives where `Segmenter` is missing.
  return ([...word][0] ?? '').toLocaleUpperCase();
}
