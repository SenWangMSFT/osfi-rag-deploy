import * as Tooltip from '@radix-ui/react-tooltip';
import { clsx } from 'clsx';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { citationTitle, highlightParts, makeSnippet, plainText } from '../lib/answer';
import { pageLabel } from '../lib/format';
import type { Citation } from '../types';
import { InstitutionMark } from './InstitutionMark';

export function SourceSnippet({
  excerpt,
  figures,
  radius,
  className,
}: {
  excerpt: string | null;
  figures: readonly string[];
  radius?: number;
  className?: string;
}) {
  const parts = useMemo(() => {
    const snippet = makeSnippet(plainText(excerpt ?? ''), figures, radius);
    return highlightParts(snippet.before + snippet.match + snippet.after, figures);
  }, [excerpt, figures, radius]);
  if (parts.every((part) => !part.text)) return null;
  return (
    <p className={clsx('snippet', className)}>
      {parts.map((part, index) => (part.marked ? <mark key={index}>{part.text}</mark> : part.text))}
    </p>
  );
}

export function NumberBadge({ n, active = false }: { n: number; active?: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[11px] font-semibold tabular-nums ring-1 ring-inset',
        active ? 'bg-brand-700 text-white ring-brand-700' : 'bg-brand-50 text-brand-700 ring-brand-200',
      )}
    >
      {n}
    </span>
  );
}

interface ChipProps {
  citation: Citation;
  figures: readonly string[];
  active: boolean;
  onOpen: () => void;
}

/** Inline [n] marker: hover for a preview of the source, click to open the cited page. */
export function CitationChip({ citation, figures, active, onOpen }: ChipProps) {
  const title = citationTitle(citation);
  const page = pageLabel(citation.page_from, citation.page_to);
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={onOpen}
          aria-expanded={active}
          aria-controls="source-panel"
          aria-label={`Source ${citation.n}: ${title}, ${page}`}
          className={clsx(
            'relative -top-[0.08em] mx-[0.12em] inline-flex h-[1.3em] min-w-[1.3em] items-center justify-center rounded-[0.35em] px-[0.3em] align-middle text-[0.72em] font-semibold leading-none tabular-nums ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
            active
              ? 'bg-brand-700 text-white ring-brand-700'
              : 'bg-brand-50 text-brand-700 ring-brand-200 hover:bg-brand-100 hover:ring-brand-300',
          )}
        >
          {citation.n}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={6}
          collisionPadding={16}
          className="z-50 w-80 max-w-[calc(100vw-2rem)] animate-fade-up rounded-xl border border-slate-200 bg-white p-3.5 text-left shadow-xl shadow-slate-900/10"
        >
          <div className="flex items-start gap-2.5">
            <InstitutionMark name={citation.institution ?? title} size="sm" />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold leading-5 text-slate-900">{title}</p>
              <p className="text-xs text-slate-500">{[citation.institution, page].filter(Boolean).join(' · ')}</p>
            </div>
          </div>
          <SourceSnippet
            excerpt={citation.excerpt}
            figures={figures}
            className="mt-2.5 line-clamp-4 text-xs leading-5 text-slate-600"
          />
          <p className="mt-2.5 flex items-center gap-1 text-[11px] font-medium text-brand-700">
            Click to open {page} <ArrowRight className="size-3" aria-hidden="true" />
          </p>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

interface ListProps {
  citations: Citation[];
  figures: ReadonlyMap<number, readonly string[]>;
  activeN: number | null;
  onOpen: (n: number) => void;
}

export function SourceList({ citations, figures, activeN, onOpen }: ListProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  return (
    <section aria-label="Sources" className="mt-6">
      <h3>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={`Sources (${citations.length})`}
          onClick={() => setExpanded((open) => !open)}
          className="disclosure-button"
        >
          <ChevronDown className={clsx('size-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
          Sources <span className="font-normal tabular-nums text-slate-500">({citations.length})</span>
        </button>
      </h3>
      <div id={listId} hidden={!expanded}>
        <ul aria-label="Source cards" className="source-list mt-2.5 grid gap-2">
          {citations.map((citation) => {
            const active = activeN === citation.n;
            return (
              <li key={citation.n}>
                <button
                  type="button"
                  onClick={() => onOpen(citation.n)}
                  aria-pressed={active}
                  aria-controls="source-panel"
                  className={clsx(
                    'flex h-full w-full min-w-0 flex-col gap-2 rounded-lg border bg-white p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50',
                    active ? 'border-brand-400 bg-brand-50/40' : 'border-slate-200 hover:border-brand-300 hover:bg-brand-50/30',
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <NumberBadge n={citation.n} active={active} />
                    <InstitutionMark name={citation.institution ?? citationTitle(citation)} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-900">
                      {citationTitle(citation)}
                    </span>
                    <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-slate-600">
                      {pageLabel(citation.page_from, citation.page_to)}
                    </span>
                  </span>
                  <SourceSnippet
                    excerpt={citation.excerpt}
                    figures={figures.get(citation.n) ?? []}
                    radius={70}
                    className="line-clamp-2 text-xs leading-5 text-slate-500"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
