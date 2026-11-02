'use client';

import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';

/**
 * Form controls.
 *
 * The composer lays labels out in a row (label left, control right) to match the
 * design, so `Field` here is the *stacked* variant used by the login and
 * settings forms; the composer uses `Row` below.
 */

const CONTROL = [
  'w-full bg-muted text-ink placeholder:text-ink-muted',
  'border border-line rounded-lg',
  'transition-colors duration-150',
  'hover:border-line-strong',
  'focus:border-brand-border focus:outline-none focus:ring-2 focus:ring-brand-soft',
  'disabled:opacity-50 disabled:cursor-not-allowed',
].join(' ');

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input className={`${CONTROL} h-10 px-3 text-sm ${className}`} {...rest} />;
}

export function Textarea({
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea className={`${CONTROL} px-3 py-2.5 text-sm leading-relaxed resize-y ${className}`} {...rest} />;
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: (id: string) => ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink-secondary">
        {label}
        {required && <span className="ml-0.5 text-failed">*</span>}
      </label>
      {children(id)}
      {/* Error replaces the hint rather than stacking, so the row never jumps. */}
      {error ? (
        <p className="text-xs text-failed">{error}</p>
      ) : hint ? (
        <p className="text-xs text-ink-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Composer row: a fixed-width label on the left and the control on the right,
 * matching the design's From / To / Subject layout.
 */
export function Row({
  label,
  error,
  children,
  right,
}: {
  label: string;
  error?: string | null;
  children: ReactNode;
  right?: ReactNode;
}): ReactNode {
  return (
    <div className="border-b border-line">
      <div className="flex min-h-11 items-center gap-3 px-1">
        <span className="w-[4.5rem] shrink-0 text-right text-[13px] text-ink-muted sm:w-24">
          {label}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {error && <p className="pb-1.5 pl-[5.5rem] text-xs text-failed sm:pl-[6.75rem]">{error}</p>}
    </div>
  );
}

/** Borderless input used inside a composer Row. */
export function BareInput({
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      className={`w-full bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none ${className}`}
      {...rest}
    />
  );
}
