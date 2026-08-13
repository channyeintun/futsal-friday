/**
 * Inline SVG icons.
 *
 * Material Symbols would mean pulling an icon font over the network on first
 * paint — measurable latency inside a chat webview on a phone, for a set of a
 * dozen glyphs. These are drawn in the same 24px outline style and cost
 * nothing.
 */

export type IconName =
  | 'ball'
  | 'money'
  | 'history'
  | 'tune'
  | 'copy'
  | 'trophy'
  | 'check'
  | 'close'
  | 'add'
  | 'edit'
  | 'place'
  | 'back'
  | 'camera'
  | 'logout'
  | 'person'
  | 'clock'
  | 'bell'
  | 'share';

const PATHS: Record<IconName, React.ReactNode> = {
  ball: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5 15.5 10l-1.3 4h-4.4L8.5 10z" />
      <path d="M12 3v4.5M4.2 9.5 8.5 10M19.8 9.5 15.5 10M7.2 19l2.6-5M16.8 19l-2.6-5" />
    </>
  ),
  money: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
      <circle cx="12" cy="12" r="2.75" />
      <path d="M6 9v6M18 9v6" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3 4v4h4" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.2 1.9" />
    </>
  ),
  tune: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="8" cy="17" r="2.2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15" />
    </>
  ),
  // A cup: two handles, a bowl, a stem and a base.
  trophy: (
    <>
      <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" />
      <path d="M12 14v4M9 20h6" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  add: <path d="M12 5v14M5 12h14" />,
  edit: (
    <>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
      <path d="M14.5 7.5 16.5 9.5" />
    </>
  ),
  place: (
    <>
      <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  camera: (
    <>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.9l1.2-2h6.8l1.2 2h1.9A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
      <circle cx="12" cy="13" r="3.4" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" />
      <path d="M17 8.5 20.5 12 17 15.5M20 12h-9" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9a6 6 0 1 1 12 0c0 3.4.8 5.3 1.6 6.3.4.5 0 1.2-.6 1.2H5c-.6 0-1-.7-.6-1.2C5.2 14.3 6 12.4 6 9z" />
      <path d="M10 20a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  // iOS share sheet glyph, used in the "Add to Home Screen" hint.
  share: (
    <>
      <path d="M12 15V3.5" />
      <path d="M8.5 7 12 3.5 15.5 7" />
      <path d="M6 12.5v6A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5v-6" />
    </>
  ),
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** Material Web components place icons in a named slot. */
  slot?: string;
}

export function Icon({ name, size = 22, className, slot }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      slot={slot}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
