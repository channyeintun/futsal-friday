import { type Locale, LOCALES, LOCALE_LABELS } from '@futsal/shared';

/**
 * A two-way language switch, sized as a control rather than as a decision.
 *
 * The onboarding screens ask "what language do you read?" as most of what is
 * on them, and a pair of full-height Material buttons is right there. Inside a
 * dialog it is not: the announcement dialog also carries body copy, a text
 * field and the message preview, and two 40px buttons with a button's padding
 * were taking a strip of it to answer a question most people answer once.
 *
 * Adjacent segments in one track, so it reads as one control with two states
 * instead of two things you could press. No visible label — the aria one does
 * that work, and a caption over a two-item switch costs more room than the
 * switch.
 */
export function LanguageToggle({
  value,
  onChange,
  label,
}: {
  value: Locale;
  onChange(next: Locale): void;
  /** Names the group for a screen reader; there is no visible caption. */
  label: string;
}) {
  return (
    <div className="lang-switch" role="group" aria-label={label}>
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          // Burmese needs a Myanmar face and more room under the baseline —
          // tagged per option, because the two labels are in two scripts.
          lang={code}
          className={`lang-option${code === value ? ' is-on' : ''}`}
          // Silent: this is one control with two states rather than two things
          // to press, and it sits directly under the field an organizer is
          // typing a jab into. See `platform.sound`.
          data-sound="none"
          aria-pressed={code === value}
          onClick={() => onChange(code)}
        >
          {LOCALE_LABELS[code]}
        </button>
      ))}
    </div>
  );
}
