import { ArrowUpRight } from 'lucide-react';
import { RouteLink } from '../hooks/useRoute';
import { MODES } from '../lib/modes';

const SUGGESTIONS = [
  { label: 'Capital adequacy', text: "What was RBC's CET1 ratio at the end of fiscal 2025?" },
  { label: 'Compare institutions', text: 'Compare the CET1 ratios of RBC and TD at the end of fiscal 2025.' },
  { label: 'Financial performance', text: "What were BMO's net income and diluted EPS for fiscal 2025?" },
  { label: 'Risk outlook', text: 'What top and emerging risks does Scotiabank highlight?' },
];

interface Props {
  documentsError: string | null;
  onAsk: (question: string) => void;
  onNavigate: (path: string) => void;
}

export function EmptyState({ documentsError, onAsk, onNavigate }: Props) {
  return (
    <div className="empty-state">
      <div className="animate-fade-up">
        <p className="mb-4 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-700">
          <span className="h-px w-7 bg-brand-600" aria-hidden="true" />
          Canadian financial institutions
        </p>
        <h2 className="text-[32px] font-semibold leading-tight tracking-[-0.035em] text-slate-900 sm:text-4xl">
          Start with a question.
        </h2>
        <p className="mt-4 max-w-lg text-[15px] leading-7 text-slate-600">
          Explore the annual reports, compare institutions, and follow the sources behind each answer.
        </p>
        <p className="mt-3 max-w-lg text-[13px] leading-6 text-slate-500">
          Choose how answers are produced under the question box. Read how{' '}
          <RouteLink href={MODES.direct.path} onNavigate={onNavigate} className="empty-state-link">
            {MODES.direct.label}
          </RouteLink>{' '}
          and the{' '}
          <RouteLink href={MODES.agent.path} onNavigate={onNavigate} className="empty-state-link">
            {MODES.agent.label}
          </RouteLink>{' '}
          work.
        </p>
      </div>

      <section aria-label="Suggested questions" className="mt-9 grid gap-x-7 sm:grid-cols-2">
        {SUGGESTIONS.map(({ label, text }) => (
          <button key={label} type="button" onClick={() => onAsk(text)}
            className="suggestion group">
            <span className="min-w-0 flex-1">
              <span className="mb-1.5 block text-[11px] font-medium text-slate-500">{label}</span>
              <span className="block text-[13px] leading-6 text-slate-700 group-hover:text-brand-800">{text}</span>
            </span>
            <ArrowUpRight className="mt-1 size-4 shrink-0 text-slate-400 group-hover:text-brand-700" aria-hidden="true" />
          </button>
        ))}
      </section>

      {documentsError && <p role="alert" className="mt-6 text-sm text-rose-700">{documentsError}</p>}
    </div>
  );
}
