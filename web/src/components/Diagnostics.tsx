import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { formatCount, formatSeconds } from '../lib/format';
import type { ActivityStage, Diagnostics } from '../types';

function reportedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function reportedCount(value: unknown): string {
  const number = reportedNumber(value);
  return number === null ? 'Not reported' : formatCount(number);
}

function durationLabel(ms: number): string {
  return ms < 1000 ? `${formatCount(ms)} ms` : formatSeconds(ms);
}

function stageTiming(stages: ActivityStage[]) {
  const durations = stages.flatMap((stage) => {
    const duration = reportedNumber(stage.elapsed_ms);
    return duration === null ? [] : [duration];
  });
  return {
    ms: durations.length > 0 ? reportedNumber(durations.reduce((sum, value) => sum + value, 0)) : null,
    count: stages.length,
    timed: durations.length,
    complete: stages.length > 0 && durations.length === stages.length,
  };
}

function stageName(type: unknown): string {
  switch (type) {
    case 'modelQueryPlanning': return 'Query planning';
    case 'searchIndex': return 'Report search';
    case 'modelAnswerSynthesis': return 'Answer writing';
    default: return typeof type === 'string' && type.trim() ? type : 'Unspecified stage';
  }
}

function errorText(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error instanceof Error) return error.message || error.name;
  try {
    const text = JSON.stringify(error);
    if (text && text !== '{}' && text !== '""') return text;
  } catch {
    // Unexpected error objects must not prevent the remaining activity from rendering.
  }
  return 'The service reported an error without details.';
}

/** Service-reported evidence steps, with measured durations distinct from the derived remainder. */
export function DiagnosticsView({ diagnostics }: { diagnostics: Diagnostics }) {
  return diagnostics.mode === 'agent'
    ? <AgentDiagnosticsView diagnostics={diagnostics} />
    : <DirectDiagnosticsView diagnostics={diagnostics} />;
}

function reportedActivity(diagnostics: Diagnostics): ActivityStage[] {
  return Array.isArray(diagnostics.activity)
    ? diagnostics.activity.filter((stage) => stage && typeof stage === 'object' && !Array.isArray(stage))
    : [];
}

function DirectDiagnosticsView({ diagnostics }: { diagnostics: Diagnostics }) {
  const activity = reportedActivity(diagnostics);
  const searches = activity.filter((stage) => stage.type === 'searchIndex');
  const planning = stageTiming(activity.filter((stage) => stage.type === 'modelQueryPlanning'));
  const writing = stageTiming(activity.filter((stage) => stage.type === 'modelAnswerSynthesis'));
  const errors = activity.flatMap((stage, index) =>
    stage.error != null ? [{ stage, index, text: errorText(stage.error) }] : [],
  );
  const total = reportedNumber(diagnostics.elapsed_ms);
  const measured = planning.ms !== null && writing.ms !== null ? planning.ms + writing.ms : null;
  const remaining = total !== null && measured !== null && planning.complete && writing.complete && measured <= total
    ? total - measured
    : null;
  const remainderNote = total === null
    ? 'The service did not report a total duration.'
    : !planning.complete || !writing.complete
      ? 'Planning or writing timing is incomplete, so the remaining time cannot be isolated.'
      : measured !== null && measured > total
        ? 'Reported stage durations exceed the total and may overlap; remaining time cannot be isolated.'
        : 'Total minus measured planning and writing. The remainder may include search and other service work; it is not a measured search duration.';
  const references = reportedNumber(diagnostics.reference_count);
  const citations = reportedNumber(diagnostics.citation_count);
  const status = reportedNumber(diagnostics.retrieve_status);
  const partial = status === 206;
  const failed = status !== null && (status < 200 || status >= 300);

  return (
    <section aria-label="Retrieval details" className="diagnostics-panel animate-fade-up">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-[13px] font-semibold text-slate-800">Evidence process</h4>
        <span className={clsx('text-[11px]', partial || failed || errors.length > 0 ? 'text-amber-800' : 'text-slate-500')}>
          {partial ? 'Partial retrieval' : failed ? 'Retrieval error' : errors.length > 0
            ? 'Activity errors reported' : status === null ? 'Status not reported'
              : activity.length === 0 ? 'Activity not reported' : 'Service-reported activity'}
        </span>
      </div>
      <p className="mt-1">
        {references === null ? 'Passage count not reported' : `${formatCount(references)} ${references === 1 ? 'passage' : 'passages'} retrieved`}
        {' · '}
        {citations === null ? 'Citation count not reported' : `${formatCount(citations)} ${citations === 1 ? 'citation' : 'citations'} in the answer`}
      </p>
      {(partial || failed) && (
        <p className="mt-2 text-amber-800">
          Retrieval returned HTTP {status}. {partial ? 'Some results may be missing.' : 'The available details may be incomplete.'}
        </p>
      )}
      {activity.length === 0 && (
        <p className="mt-2 rounded-md bg-slate-50 px-3 py-2">
          No stage activity was reported. Available counts and total time are still shown.
        </p>
      )}
      {errors.length > 0 && (
        <section role="alert" aria-label="Activity errors" className="mt-3 rounded-lg border border-rose-200 bg-rose-50/40 p-3">
          <h5 className="font-semibold text-rose-800">
            {errors.length} activity {errors.length === 1 ? 'error' : 'errors'} reported
          </h5>
          <ul className="mt-2 space-y-2">
            {errors.map(({ stage, index, text }) => (
              <li key={index}>
                <p className="font-medium text-rose-900">{stageName(stage.type)} · activity {index + 1}</p>
                <p className="text-rose-800">{text}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ol aria-label="Retrieval stages" className="diagnostic-timeline">
        <ProcessStep number={1} title="Query planning" detail={<Timing value={planning} />}>
          <TimingNote value={planning} label="Planning" />
        </ProcessStep>
        <ProcessStep number={2} title="Report search"
          detail={searches.length > 0 ? `${searches.length} ${searches.length === 1 ? 'query' : 'queries'} reported` : 'Not reported'}>
          {searches.length > 0 ? (
            <ul aria-label="Reported search queries" className="mt-2 space-y-1.5">
              {searches.map((search, index) => {
                const count = reportedNumber(search.count);
                const duration = reportedNumber(search.elapsed_ms);
                return (
                  <li key={index} className="diagnostic-query">
                    <p className="text-slate-700">
                      {typeof search.query === 'string' && search.query.trim() ? search.query : 'Query text not reported.'}
                    </p>
                    <p className="mt-0.5 text-[11px] tabular-nums text-slate-500">
                      {count === null ? 'Match count not reported' : `${formatCount(count)} ${count === 1 ? 'match' : 'matches'} returned`}
                      {duration !== null && ` · ${durationLabel(duration)} measured`}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : <p className="mt-1">No search queries were reported; this does not mean no search ran.</p>}
          {references === 0 && <p className="mt-1">No passages were retrieved.</p>}
        </ProcessStep>
        <ProcessStep number={3} title="Answer writing" detail={<Timing value={writing} />}>
          <TimingNote value={writing} label="Writing" />
        </ProcessStep>
        <ProcessStep number={4} title="Source matching">
          <SourceMatching diagnostics={diagnostics} />
        </ProcessStep>
      </ol>

      <div className="mt-4 border-t border-slate-100 pt-3">
        <dl className="diagnostic-values">
          <Metric label="Total service time" value={total === null ? 'Not reported' : durationLabel(total)} />
          <Metric label="Remaining service time" value={remaining === null ? 'Not attributable' : durationLabel(remaining)} />
        </dl>
        <p className="mt-1 text-[11px] text-slate-500">{remainderNote}</p>
      </div>

      <TechnicalDetails diagnostics={diagnostics} />
    </section>
  );
}

/** The Foundry agent reports its knowledge base calls and token usage, but not per-stage timings. */
function AgentDiagnosticsView({ diagnostics }: { diagnostics: Diagnostics }) {
  const activity = reportedActivity(diagnostics);
  const calls = activity.filter((stage) => stage.type === 'knowledgeBaseCall');
  const errors = activity.flatMap((stage, index) =>
    stage.error != null ? [{ stage, index, text: errorText(stage.error) }] : [],
  );
  const agent = diagnostics.agent && typeof diagnostics.agent === 'object' ? diagnostics.agent : null;
  const total = reportedNumber(diagnostics.elapsed_ms);
  const references = reportedNumber(diagnostics.reference_count);
  const citations = reportedNumber(diagnostics.citation_count);
  const partial = reportedNumber(diagnostics.retrieve_status) === 206;
  const model = agent?.model ? ` (${agent.model})` : '';

  return (
    <section aria-label="Retrieval details" className="diagnostics-panel animate-fade-up">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-[13px] font-semibold text-slate-800">Evidence process</h4>
        <span className={clsx('text-[11px]', partial || errors.length > 0 ? 'text-amber-800' : 'text-slate-500')}>
          {partial ? 'Partial retrieval' : errors.length > 0 ? 'Tool errors reported' : 'Agent-reported activity'}
        </span>
      </div>
      <p className="mt-1">
        {references === null ? 'Passage count not reported' : `${formatCount(references)} ${references === 1 ? 'passage' : 'passages'} retrieved`}
        {' · '}
        {citations === null ? 'Citation count not reported' : `${formatCount(citations)} ${citations === 1 ? 'citation' : 'citations'} in the answer`}
      </p>
      {partial && <p className="mt-2 text-amber-800">At least one knowledge base call failed. Some results may be missing.</p>}

      <ol aria-label="Agent stages" className="diagnostic-timeline">
        <ProcessStep number={1} title="Agent run"
          detail={agent?.name ? `${agent.name}${agent.version ? ` · version ${agent.version}` : ''}` : 'Not reported'}>
          <p className="mt-1">The Foundry agent{model} read the question and the conversation, then decided how to search.</p>
        </ProcessStep>
        <ProcessStep number={2} title="Knowledge base search"
          detail={`${calls.length} ${calls.length === 1 ? 'tool call' : 'tool calls'}`}>
          {calls.length > 0 ? (
            <ul aria-label="Knowledge base calls" className="mt-2 space-y-1.5">
              {calls.map((call, index) => {
                const count = reportedNumber(call.count);
                return (
                  <li key={index} className="diagnostic-query">
                    <p className="text-slate-700">
                      {typeof call.query === 'string' && call.query.trim() ? call.query : 'Query text not reported.'}
                    </p>
                    <p className="mt-0.5 text-[11px] tabular-nums text-slate-500">
                      {count === null ? 'Passage count not reported' : `${formatCount(count)} ${count === 1 ? 'passage' : 'passages'} returned`}
                      {call.error != null
                        ? <span className="text-rose-700"> · Failed: {errorText(call.error)}</span>
                        : call.status && call.status !== 'completed' ? ` · ${call.status}` : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-1 text-amber-800">The agent didn't call the knowledge base, so this answer isn't grounded in the reports.</p>
          )}
        </ProcessStep>
        <ProcessStep number={3} title="Answer writing">
          <p className="mt-1">The agent wrote the answer from the returned passages and cited each one it used.</p>
        </ProcessStep>
        <ProcessStep number={4} title="Source matching">
          <SourceMatching diagnostics={diagnostics} />
        </ProcessStep>
      </ol>

      <div className="mt-4 border-t border-slate-100 pt-3">
        <dl className="diagnostic-values">
          <Metric label="Total service time" value={total === null ? 'Not reported' : durationLabel(total)} />
        </dl>
        <p className="mt-1 text-[11px] text-slate-500">Foundry Agent Service reports the total only; its stages aren't timed separately.</p>
      </div>

      <TechnicalDetails diagnostics={diagnostics}>
        {agent && (
          <dl className="diagnostic-values mt-3 border-t border-slate-100 pt-3">
            <Metric label="Agent version" value={agent.version ?? 'Not reported'} />
            <Metric label="Model deployment" value={agent.model ?? 'Not reported'} />
            <Metric label="Run status" value={agent.status ?? 'Not reported'} />
            <Metric label="Response ID" value={agent.response_id ?? 'Not reported'} />
          </dl>
        )}
      </TechnicalDetails>
    </section>
  );
}

function SourceMatching({ diagnostics }: { diagnostics: Diagnostics }) {
  const citations = reportedNumber(diagnostics.citation_count);
  const removed = (Array.isArray(diagnostics.unresolved_ref_ids) ? diagnostics.unresolved_ref_ids.length : 0)
    + (Array.isArray(diagnostics.incomplete_ref_ids) ? diagnostics.incomplete_ref_ids.length : 0);
  const matching = diagnostics.gate_passed === false
    ? 'Source matching did not pass.'
    : diagnostics.gate_passed === true
      ? citations === 0 ? 'No citations were linked to passages.' : 'Citations were linked to retrieved passages.'
      : 'Source matching was not reported.';
  return (
    <>
      <p className="mt-1">{matching}</p>
      {removed > 0 && (
        <p className="mt-1 text-amber-800">
          {removed} citation {removed === 1 ? 'reference was' : 'references were'} removed because a matching passage or required metadata was missing.
        </p>
      )}
      <p className="mt-1 text-slate-500">Source matching links citations to passages. It does not verify the accuracy of the answer.</p>
    </>
  );
}

function TechnicalDetails({ diagnostics, children }: { diagnostics: Diagnostics; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const coverage = reportedNumber(diagnostics.grounded_sentence_ratio);
  return (
    <div className="mt-3 border-t border-slate-100 pt-2">
      <button type="button" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((current) => !current)} className="disclosure-button">
        <ChevronDown className={clsx('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
        Technical details
      </button>
      <div id={id} hidden={!open}>
        <dl className="diagnostic-values mt-2">
          <Metric label="Input tokens" value={reportedCount(diagnostics.input_tokens)} />
          <Metric label="Output tokens" value={reportedCount(diagnostics.output_tokens)} />
          <Metric label="Reasoning tokens" value={reportedCount(diagnostics.reasoning_tokens)} />
          <Metric label="Cited sentences (heuristic)"
            value={reportedNumber(diagnostics.sentences_grounded) !== null && reportedNumber(diagnostics.sentences_total) !== null
              ? `${formatCount(diagnostics.sentences_grounded)} of ${formatCount(diagnostics.sentences_total)}` : 'Not reported'} />
          <Metric label="Sentence citation coverage"
            value={coverage !== null && coverage <= 1 ? `${Math.round(coverage * 100)}%` : 'Not reported'} />
        </dl>
        <p className="mt-2 text-[11px] text-slate-500">
          Usage tokens are service-reported. Sentence coverage is a citation heuristic, not a factual accuracy score.
        </p>
        {children}
        {diagnostics.conversation && (
          <section aria-label="Conversation context" className="mt-3 border-t border-slate-100 pt-3">
            <h5 className="font-semibold text-slate-800">Conversation context</h5>
            <dl className="diagnostic-values mt-1">
              <Metric label="History messages received" value={reportedCount(diagnostics.conversation.history_messages_received)} />
              <Metric label="History messages used" value={reportedCount(diagnostics.conversation.history_messages_used)} />
              <Metric label="History messages omitted" value={reportedCount(diagnostics.conversation.history_messages_omitted)} />
              <Metric label="Estimated input tokens" value={reportedCount(diagnostics.conversation.estimated_input_tokens)} />
              <Metric label="Conversation token budget" value={reportedCount(diagnostics.conversation.token_budget)} />
            </dl>
            <p className="mt-2 text-[11px] text-slate-500">
              Conversation input tokens are estimates, not measured model usage.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

function ProcessStep({ number, title, detail, children }: {
  number: number; title: string; detail?: ReactNode; children: ReactNode;
}) {
  return (
    <li className="diagnostic-step">
      <span className="diagnostic-step-marker" aria-hidden="true">{number}</span>
      <div className="diagnostic-step-header">
        <h5 className="font-semibold text-slate-800">{title}</h5>
        {detail && <span className="text-[11px] tabular-nums text-slate-500">{detail}</span>}
      </div>
      {children}
    </li>
  );
}

function Timing({ value }: { value: ReturnType<typeof stageTiming> }) {
  return <>{value.ms === null ? 'Timing not reported' : `${durationLabel(value.ms)} measured${value.complete ? '' : ' (partial)'}`}</>;
}

function TimingNote({ value, label }: { value: ReturnType<typeof stageTiming>; label: string }) {
  return (
    <p className="mt-1">
      {value.count === 0 ? `${label} activity was not reported.`
        : `${value.count} ${label.toLowerCase()} ${value.count === 1 ? 'stage' : 'stages'} reported.${value.complete ? '' : ` ${value.timed} of ${value.count} durations available.`}`}
    </p>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
