'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The one button in the app.
 *
 * Variants are a closed union rather than free-form classNames, so "primary"
 * looks identical everywhere and there is one place to change it. `loading` is
 * built in because every mutating action needs a busy state, and
 * re-implementing that per call site is how double-submits ship.
 *
 * `primary` uses --brand-strong, not --brand: white text on the design's
 * brighter green measures 3.21:1, below the 4.5:1 a button label needs.
 */

type Variant = 'primary' | 'soft' | 'outline' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-strong text-white hover:brightness-110 active:brightness-95',
  // The design's mint fill: pale green background with green text.
  soft: 'bg-brand-soft text-brand-strong hover:brightness-[0.97] border border-transparent',
  // Pill with a green outline, used for Send / Send Later.
  outline:
    'bg-surface text-brand-strong border border-brand-border hover:bg-brand-soft',
  secondary: 'bg-surface text-ink border border-line hover:bg-hover',
  ghost: 'bg-transparent text-ink-secondary hover:bg-hover hover:text-ink',
  danger: 'bg-failed text-white hover:brightness-110',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9.5 px-4 text-[13.5px] gap-2 rounded-lg',
  lg: 'h-11 px-5 text-sm gap-2 rounded-lg',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  fullWidth = false,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      // A loading button must also be unclickable, not merely look busy.
      disabled={disabled || loading}
      className={[
        'inline-flex items-center justify-center font-medium whitespace-nowrap',
        'transition-all duration-150 cursor-pointer',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        fullWidth ? 'w-full' : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  );
}

export function Spinner({ className = 'size-4' }: { className?: string }): ReactNode {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Square icon-only button, for the toolbar row and list-row actions. */
export function IconButton({
  label,
  active = false,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={[
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
        'transition-colors duration-150 cursor-pointer',
        active ? 'bg-brand-soft text-brand-strong' : 'text-ink-muted hover:bg-hover hover:text-ink',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}
