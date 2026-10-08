import { clsx } from 'clsx';
import { BookOpen, CircleStop, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode, type Ref } from 'react';
import { RouteLink } from '../hooks/useRoute';
import { MODES, turnMode } from '../lib/modes';
import type { AnswerMode, Turn } from '../types';
import { AnswerView } from './AnswerView';
import { ErrorBoundary } from './ErrorBoundary';
import { Button } from './ui';

interface Props {
  ref?: Ref<HTMLElement>;
  turn: Turn;
  canRetry: boolean;
  activeCitation: number | null;
  documentCount: number | null;
  onOpenCitation: (turnId: string, n: number) => void;
  onRetry: (turnId: string) => void;
  onNavigate: (path: string) => void;
}

export function TurnView({ ref, turn, canRetry, activeCitation, documentCount, onOpenCitation, onRetry, onNavigate }: Props) {
  const retry = canRetry ? () => onRetry(turn.id) : undefined;
  const openCitation = useCallback((n: number) => onOpenCitation(turn.id, n), [onOpenCitation, turn.id]);
  const mode = turnMode(turn);
  return (
    <article ref={ref} aria-labelledby={`question-${turn.id}`} className="conversation-turn">
      <div className="user-message-group">
        <span className="mb-2 block text-right text-[11px] font-medium text-slate-500">You</span>
        <h2 id={`question-${turn.id}`} className="user-message">
          {turn.question}
        </h2>
      </div>
      <div className="assistant-message">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg border border-brand-100 bg-brand-50 text-brand-700">
            <BookOpen className="size-3.5" aria-hidden="true" />
          </span>
          <span className="text-xs font-semibold text-slate-700">Research assistant</span>
          <RouteLink href={MODES[mode].path} onNavigate={onNavigate} className="mode-chip"
            title={`Answered by ${MODES[mode].label}. How it works`}>
            {MODES[mode].label}
          </RouteLink>
          <span className="text-[10px] text-slate-500">AI-generated</span>
        </div>
        <div aria-live="polite" aria-atomic="false">
          {turn.status === 'pending' && <Pending startedAt={turn.askedAt} documentCount={documentCount} mode={mode} />}
          {turn.status === 'error' && (
            <Problem icon={<TriangleAlert className="size-4 text-rose-600" />} tone="error" onRetry={retry}>
              {turn.error}
            </Problem>
          )}
          {turn.status === 'stopped' && (
            <Problem icon={<CircleStop className="size-4 text-slate-500" />} tone="muted" onRetry={retry}>
              Stopped before the answer arrived.
            </Problem>
          )}
          {turn.status === 'done' && turn.response && (
            <div className="animate-fade-up">
              <ErrorBoundary
                fallback={
                  <Problem icon={<TriangleAlert className="size-4 text-rose-600" />} tone="error">
                    This answer couldn't be displayed.
                  </Problem>
                }
              >
                <AnswerView response={turn.response} activeCitation={activeCitation} onOpenCitation={openCitation} />
              </ErrorBoundary>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function Pending({ startedAt, documentCount, mode }: { startedAt: number; documentCount: number | null; mode: AnswerMode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, now - startedAt);
  const reports = documentCount ? `${documentCount} annual reports` : 'the annual reports';
  const working = mode === 'agent' ? `The Foundry agent is searching ${reports}...` : `Reviewing ${reports}...`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5 text-sm">
        <LoaderCircle className="size-4 animate-spin text-brand-600" aria-hidden="true" />
        <span role="status" className="font-medium text-slate-700">
          {elapsed >= 20_000 ? 'Still working on your answer...' : working}
        </span>
        <span aria-hidden="true" className="tabular-nums text-slate-500">{Math.floor(elapsed / 1000)} s</span>
      </div>
      <div className="space-y-2.5 pt-1" aria-hidden="true">
        {['w-11/12', 'w-full', 'w-4/5', 'w-3/5'].map((width) => (
          <div key={width} className={clsx('skeleton h-3 rounded-full', width)} />
        ))}
      </div>
    </div>
  );
}

function Problem({
  icon,
  tone,
  onRetry,
  children,
}: {
  icon: ReactNode;
  tone: 'error' | 'muted';
  onRetry?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={clsx(
        'flex animate-fade-up items-center gap-3 rounded-xl px-4 py-3 text-sm ring-1 ring-inset',
        tone === 'error' ? 'bg-rose-50 text-rose-900 ring-rose-200' : 'bg-slate-100/70 text-slate-600 ring-slate-200',
      )}
    >
      <span className="shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="flex-1 leading-5">{children}</span>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="size-3.5" aria-hidden="true" /> Try again
        </Button>
      )}
    </div>
  );
}
