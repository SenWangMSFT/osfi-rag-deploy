import { clsx } from 'clsx';
import { institutionMark, institutionTone } from '../lib/format';

const sizes = {
  xs: 'h-5 min-w-5 rounded-full px-1 text-[9px]',
  sm: 'h-6 min-w-6 rounded-md px-1 text-[10px]',
  md: 'h-8 min-w-8 rounded-lg px-1.5 text-[11px]',
};

export function InstitutionMark({ name, size = 'md' }: { name: string; size?: keyof typeof sizes }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'inline-flex shrink-0 items-center justify-center font-bold tracking-tight ring-1 ring-inset',
        sizes[size],
        institutionTone(name),
      )}
    >
      {institutionMark(name)}
    </span>
  );
}
