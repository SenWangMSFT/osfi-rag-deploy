import { clsx } from 'clsx';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';

export function containModalFocus(event: KeyboardEvent<HTMLDialogElement>) {
  const dialog = event.currentTarget;
  if (event.key !== 'Tab' || !dialog.matches(':modal')) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, a[href], input, textarea, select, iframe, [tabindex]',
  )).filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

type Variant = 'primary' | 'outline' | 'ghost';

const base =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:cursor-not-allowed';

const variants: Record<Variant, string> = {
  primary: 'bg-brand-800 text-white hover:bg-brand-900 disabled:bg-slate-100 disabled:text-slate-500',
  outline:
    'border border-slate-200 bg-white text-slate-700 shadow-xs hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 disabled:text-slate-400 disabled:hover:bg-white',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:text-slate-400 disabled:hover:bg-transparent',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
}

export function Button({ variant = 'outline', size = 'md', className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={clsx(base, variants[variant], size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm', className)}
      {...props}
    />
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, className, children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(base, variants.ghost, 'size-8 text-slate-500', className)}
      {...props}
    >
      {children}
    </button>
  );
}

interface IconLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  label: string;
  children: ReactNode;
}

export function IconLink({ label, className, children, ...props }: IconLinkProps) {
  return (
    <a
      aria-label={label}
      title={label}
      target="_blank"
      rel="noopener noreferrer"
      className={clsx(base, variants.ghost, 'size-8 text-slate-500', className)}
      {...props}
    >
      {children}
    </a>
  );
}
