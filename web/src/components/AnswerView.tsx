import { clsx } from 'clsx';
import { Check, ChevronDown, Clock, Copy, Info, ShieldCheck, TriangleAlert, Workflow } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { answerAsText, citationNumber, citedFigures, linkCitations } from '../lib/answer';
import { formatSeconds } from '../lib/format';
import type { AskResponse, Citation } from '../types';
import { DiagnosticsView } from './Diagnostics';
import { CitationChip, SourceList } from './Sources';
import { Button } from './ui';

// Kept out of the Markdown components so switching the open source doesn't re-create (and remount) them.
const ActiveCitation = createContext<number | null>(null);

interface Props {
  response: AskResponse;
  activeCitation: number | null;
  onOpenCitation: (n: number) => void;
}

// Gate warnings that the notices below already explain in plain language.
const EXPLAINED_WARNINGS = [/^Removed citation/, /^The answer contains no verifiable citations/, /^Partial retrieval/];

export function AnswerView({ response, activeCitation, onOpenCitation }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const detailsId = useId();
  const { answer, citations, diagnostics } = response;
  const byNumber = useMemo(() => new Map(citations.map((citation) => [citation.n, citation])), [citations]);
  const figures = useMemo(
    () => new Map(citations.map((citation) => [citation.n, citedFigures(answer, citation.n)])),
    [answer, citations],
  );
  const markdown = useMemo(() => linkCitations(answer, new Set(byNumber.keys())), [answer, byNumber]);

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const n = citationNumber(href);
        const citation = n === null ? undefined : byNumber.get(n);
        if (!citation) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        }
        return <InlineCitation citation={citation} figures={figures.get(citation.n) ?? []} onOpen={onOpenCitation} />;
      },
      table: ({ children }) => (
        <div className="overflow-x-auto">
          <table>{children}</table>
        </div>
      ),
    }),
    [byNumber, figures, onOpenCitation],
  );

  const removed = diagnostics.unresolved_ref_ids.length + diagnostics.incomplete_ref_ids.length;
  const otherWarnings = response.warnings.filter((warning) => !EXPLAINED_WARNINGS.some((known) => known.test(warning)));

  return (
    <ActiveCitation.Provider value={activeCitation}>
      <div className="answer-prose prose prose-slate max-w-none text-[15px] leading-7 prose-headings:tracking-tight prose-p:my-3 prose-strong:text-slate-900 prose-li:my-1 prose-table:text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {markdown}
        </ReactMarkdown>
      </div>

      {removed > 0 && (
        <Notice>
          {removed === 1 ? 'One citation' : `${removed} citations`} could not be verified against the retrieved passages
          and {removed === 1 ? 'was' : 'were'} removed.
        </Notice>
      )}
      {diagnostics.retrieve_status === 206 && <Notice>Part of the search failed, so this answer may be incomplete.</Notice>}
      {otherWarnings.map((warning) => (
        <Notice key={warning}>{warning}</Notice>
      ))}

      {citations.length > 0 ? (
        <SourceList citations={citations} figures={figures} activeN={activeCitation} onOpen={onOpenCitation} />
      ) : (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
          <Info className="size-3.5" aria-hidden="true" /> No sources cited, so this reply isn't backed by the reports.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-1 text-xs text-slate-500">
        {citations.length > 0 && removed === 0 && diagnostics.gate_passed && (
          <span className="mr-2 inline-flex items-center gap-1 font-medium text-slate-600"
            title="Citations match retrieved passages. This does not verify the accuracy of the answer.">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {citations.length === 1 ? '1 source linked' : `${citations.length} sources linked`}
          </span>
        )}
        <CopyButton text={answerAsText(response)} />
        <Button variant="ghost" size="sm" onClick={() => setShowDetails((open) => !open)}
          aria-expanded={showDetails} aria-controls={detailsId}>
          <Workflow className="size-3.5" aria-hidden="true" />
          How this answer was found
          <ChevronDown className={clsx('size-3.5 transition-transform', showDetails && 'rotate-180')} aria-hidden="true" />
        </Button>
        <span className="ml-auto inline-flex items-center gap-1 tabular-nums text-slate-400">
          <Clock className="size-3.5" aria-hidden="true" />
          {formatSeconds(diagnostics.elapsed_ms)}
        </span>
      </div>
      <div id={detailsId} hidden={!showDetails}>{showDetails && <DiagnosticsView diagnostics={diagnostics} />}</div>
    </ActiveCitation.Provider>
  );
}

function InlineCitation({
  citation,
  figures,
  onOpen,
}: {
  citation: Citation;
  figures: readonly string[];
  onOpen: (n: number) => void;
}) {
  const active = useContext(ActiveCitation) === citation.n;
  return <CitationChip citation={citation} figures={figures} active={active} onOpen={() => onOpen(citation.n)} />;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] leading-5 text-amber-900 ring-1 ring-inset ring-amber-200">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-600" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {failed && <span role="alert" className="text-xs text-rose-700">Could not copy. Select the answer and copy it manually.</span>}
    </>
  );
}
