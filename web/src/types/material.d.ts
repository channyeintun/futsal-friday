/**
 * JSX types for the `@material/web` custom elements used in this app.
 *
 * Material Web ships web components, not React components. React 19 handles
 * them natively — it assigns non-primitive props as properties and everything
 * else as attributes — but TypeScript still needs to be told the tags exist.
 */
import type React from 'react';

type Base = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;

interface ButtonAttrs extends Base {
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  value?: string;
  name?: string;
  'trailing-icon'?: boolean;
  'has-icon'?: boolean;
}

interface TextFieldAttrs extends Base {
  label?: string;
  value?: string;
  type?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  rows?: number;
  inputmode?: string;
  'error-text'?: string;
  'supporting-text'?: string;
  error?: boolean;
  autocomplete?: string;
  maxlength?: number;
}

interface SelectAttrs extends Base {
  label?: string;
  value?: string;
  disabled?: boolean;
  required?: boolean;
  'supporting-text'?: string;
}

interface OptionAttrs extends Base {
  value?: string;
  selected?: boolean;
  disabled?: boolean;
}

interface ListItemAttrs extends Base {
  type?: 'text' | 'button' | 'link';
  href?: string;
  target?: string;
  disabled?: boolean;
}

interface DialogAttrs extends Base {
  open?: boolean;
  type?: 'alert';
}

interface ProgressAttrs extends Base {
  value?: number;
  max?: number;
  indeterminate?: boolean;
  'four-color'?: boolean;
}

interface ChipAttrs extends Base {
  label?: string;
  disabled?: boolean;
  selected?: boolean;
  elevated?: boolean;
  href?: string;
  target?: string;
}

interface SwitchAttrs extends Base {
  selected?: boolean;
  disabled?: boolean;
  icons?: boolean;
}

interface IconButtonAttrs extends Base {
  disabled?: boolean;
  href?: string;
  target?: string;
  toggle?: boolean;
  selected?: boolean;
  'aria-label'?: string;
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'md-filled-button': ButtonAttrs;
      'md-filled-tonal-button': ButtonAttrs;
      'md-outlined-button': ButtonAttrs;
      'md-text-button': ButtonAttrs;
      'md-elevated-button': ButtonAttrs;

      'md-filled-text-field': TextFieldAttrs;
      'md-outlined-text-field': TextFieldAttrs;

      'md-outlined-select': SelectAttrs;
      'md-filled-select': SelectAttrs;
      'md-select-option': OptionAttrs;

      'md-list': Base;
      'md-list-item': ListItemAttrs;
      'md-divider': Base & { inset?: boolean };

      'md-dialog': DialogAttrs;
      'md-circular-progress': ProgressAttrs;
      'md-linear-progress': ProgressAttrs;

      'md-assist-chip': ChipAttrs;
      'md-filter-chip': ChipAttrs;
      'md-suggestion-chip': ChipAttrs;
      'md-chip-set': Base;

      'md-switch': SwitchAttrs;
      'md-icon': Base;
      'md-icon-button': IconButtonAttrs;
      'md-filled-icon-button': IconButtonAttrs;
      'md-filled-tonal-icon-button': IconButtonAttrs;
      'md-outlined-icon-button': IconButtonAttrs;
    }
  }
}
