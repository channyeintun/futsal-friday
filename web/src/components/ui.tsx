import type { CSSProperties } from 'react';
import '@material/web/button/filled-button.js';
import '@material/web/button/filled-tonal-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/button/text-button.js';
import '@material/web/textfield/outlined-text-field.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';
import '@material/web/dialog/dialog.js';
import '@material/web/progress/circular-progress.js';
import '@material/web/switch/switch.js';
import '@material/web/divider/divider.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/chips/chip-set.js';
import '@material/web/chips/assist-chip.js';

import { type ReactNode, useEffect, useRef } from 'react';

/**
 * Thin React wrappers over the Material Web custom elements.
 *
 * React 19 talks to custom elements properly, but two things still need help:
 * value binding (the elements own their state) and imperative APIs like
 * `md-dialog.show()`. Both are handled here so no page has to think about it.
 */

/* ---------------------------------------------------------------- fields */

interface TextFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  type?: 'text' | 'number' | 'datetime-local' | 'url' | 'textarea';
  placeholder?: string;
  supportingText?: string;
  errorText?: string;
  required?: boolean;
  disabled?: boolean;
  inputMode?: string;
  autoFocus?: boolean;
}

export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  supportingText,
  errorText,
  required,
  disabled,
  inputMode,
  autoFocus,
}: TextFieldProps) {
  const ref = useRef<HTMLElement & { value: string }>(null);

  // The element owns its value, so listen to the DOM event directly rather
  // than relying on React's synthetic system to reach inside a shadow root.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const handler = () => onChange(element.value);
    element.addEventListener('input', handler);
    return () => element.removeEventListener('input', handler);
  }, [onChange]);

  // Keep the element in step when the value is changed from outside.
  useEffect(() => {
    const element = ref.current;
    if (element && element.value !== value) element.value = value;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <md-outlined-text-field
      ref={ref}
      className="field-full"
      label={label}
      value={value}
      type={type}
      placeholder={placeholder}
      supporting-text={supportingText}
      error-text={errorText}
      error={errorText ? true : undefined}
      required={required}
      disabled={disabled}
      inputmode={inputMode}
      rows={type === 'textarea' ? 3 : undefined}
    />
  );
}

interface SelectProps {
  label: string;
  value: string;
  onChange(value: string): void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  supportingText?: string;
}

export function Select({
  label,
  value,
  onChange,
  options,
  disabled,
  supportingText,
}: SelectProps) {
  const ref = useRef<HTMLElement & { value: string }>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const handler = () => onChange(element.value);
    element.addEventListener('change', handler);
    return () => element.removeEventListener('change', handler);
  }, [onChange]);

  useEffect(() => {
    const element = ref.current;
    if (element && element.value !== value) element.value = value;
  }, [value, options]);

  return (
    <md-outlined-select
      ref={ref}
      className="field-full"
      label={label}
      value={value}
      disabled={disabled}
      supporting-text={supportingText}
    >
      {options.map((option) => (
        <md-select-option key={option.value} value={option.value}>
          <div slot="headline">{option.label}</div>
        </md-select-option>
      ))}
    </md-outlined-select>
  );
}

export function Switch({
  selected,
  onChange,
  disabled,
}: {
  selected: boolean;
  onChange(selected: boolean): void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLElement & { selected: boolean }>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const handler = () => onChange(element.selected);
    element.addEventListener('change', handler);
    return () => element.removeEventListener('change', handler);
  }, [onChange]);

  useEffect(() => {
    const element = ref.current;
    if (element && element.selected !== selected) element.selected = selected;
  }, [selected]);

  return <md-switch ref={ref} selected={selected} disabled={disabled} />;
}

/* ---------------------------------------------------------------- dialog */

interface DialogProps {
  open: boolean;
  onClose(): void;
  headline: string;
  children: ReactNode;
  actions?: ReactNode;
}

export function Dialog({ open, onClose, headline, children, actions }: DialogProps) {
  const ref = useRef<HTMLElement & { open: boolean; show(): void; close(): void }>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // `closed` fires after the exit animation, including for Escape and
    // scrim clicks — the cases a controlled `open` prop would otherwise miss.
    const handler = () => {
      if (open) onClose();
    };
    element.addEventListener('closed', handler);
    return () => element.removeEventListener('closed', handler);
  }, [open, onClose]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) element.show();
    else if (!open && element.open) element.close();
  }, [open]);

  return (
    <md-dialog ref={ref}>
      <div slot="headline">{headline}</div>
      <form slot="content" method="dialog" className="dialog-body">
        {children}
      </form>
      <div slot="actions">{actions}</div>
    </md-dialog>
  );
}

/* --------------------------------------------------------------- buttons */

interface ButtonProps {
  children: ReactNode;
  onClick?(): void;
  disabled?: boolean;
  variant?: 'filled' | 'tonal' | 'outlined' | 'text';
  type?: 'button' | 'submit';
  /**
   * Colours the label with the error tone. Purely visual — an action that
   * takes something away should not look as inviting as one that adds.
   */
  danger?: boolean;
  /**
   * The language of the *label*, when it differs from the app's. The language
   * switcher offers each language in its own script, so its Burmese option is
   * Burmese even while everything around it is English — and Myanmar needs
   * more room under the baseline than Latin does.
   */
  lang?: string;
  /** For buttons whose visible content is an icon. */
  ariaLabel?: string;
  /**
   * Which clip this button plays, when it is not the app's usual one.
   *
   * Every button makes a noise without being asked — the listener that does it
   * lives in `platform.sound` and matches on the element, not on this prop.
   * This is only for the two exceptions: an action that takes something away
   * (`tap-out`), and one that should stay quiet (`none`).
   */
  sound?: 'tap-out' | 'none';
}

/*
 * Set as inline custom properties rather than a class.
 *
 * React does not forward `className` to a custom element — it lands as no
 * attribute at all — so a `.danger` rule in the stylesheet would never match.
 * Custom properties on the host do reach the component's internals, which is
 * how these buttons are themed everywhere else.
 */
const DANGER_TOKENS = {
  '--md-text-button-label-text-color': 'var(--md-sys-color-error)',
  '--md-text-button-icon-color': 'var(--md-sys-color-error)',
  '--md-outlined-button-label-text-color': 'var(--md-sys-color-error)',
  '--md-outlined-button-icon-color': 'var(--md-sys-color-error)',
} as CSSProperties;

export function Button({
  children,
  onClick,
  disabled,
  variant = 'filled',
  type = 'button',
  danger,
  lang,
  ariaLabel,
  sound,
}: ButtonProps) {
  const props = {
    onClick,
    disabled,
    type,
    ...(lang ? { lang } : {}),
    ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
    ...(sound ? { 'data-sound': sound } : {}),
    ...(danger ? { style: DANGER_TOKENS } : {}),
  };

  switch (variant) {
    case 'tonal':
      return <md-filled-tonal-button {...props}>{children}</md-filled-tonal-button>;
    case 'outlined':
      return <md-outlined-button {...props}>{children}</md-outlined-button>;
    case 'text':
      return <md-text-button {...props}>{children}</md-text-button>;
    default:
      return <md-filled-button {...props}>{children}</md-filled-button>;
  }
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="centered">
      <md-circular-progress indeterminate aria-label={label ?? 'Loading'} />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="error-banner" role="alert">
      {children}
    </div>
  );
}
