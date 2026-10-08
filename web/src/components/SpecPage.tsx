import { clsx } from 'clsx';
import { Check } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { RouteLink } from '../hooks/useRoute';
import { ANSWER_MODES, MODES } from '../lib/modes';
import { COMPARISON, DOCUMENTS, ROLLOUT, SCALE, SITES, SPECS, type Spec } from '../lib/specs';
import type { AnswerMode } from '../types';
import { Button } from './ui';

const SECTIONS = [
  ['overview', 'At a glance'],
  ['architecture', 'Architecture'],
  ['lifecycle', 'Request lifecycle'],
  ['configuration', 'Configuration'],
  ['documents', 'Documents from SharePoint'],
  ['scale', '100 institution sites'],
  ['prompts', 'Prompts'],
  ['citations', 'Citations'],
  ['conversation', 'Conversation and data'],
  ['permissions', 'Who sees what'],
  ['access', 'Identity and access'],
  ['setup', 'Deployment setup'],
  ['diagnostics', 'Diagnostics'],
  ['tradeoffs', 'Strengths and limitations'],
  ['comparison', 'Compare the modes'],
] as const;

interface Props {
  mode: AnswerMode;
  selectedMode: AnswerMode;
  onNavigate: (path: string) => void;
  onUseMode: (mode: AnswerMode) => void;
}

/** Technical specification of one answer mode. */
export function SpecPage({ mode, selectedMode, onNavigate, onUseMode }: Props) {
  const spec = SPECS[mode];
  const main = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const other = ANSWER_MODES.find((option) => option !== mode)!;

  useEffect(() => {
    const previous = document.title;
    document.title = `${MODES[mode].label}: how it works | OSFI`;
    return () => {
      document.title = previous;
    };
  }, [mode]);

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [mode]);

  return (
    <main id="main-content" ref={main} tabIndex={-1} aria-labelledby="spec-title" className="spec-page">
      <div className="spec-layout">
        <nav aria-label="On this page" className="spec-toc">
          <p className="spec-toc-title">On this page</p>
          <ul>
            {SECTIONS.map(([id, title]) => (
              <li key={id}><a href={`#${id}`}>{title}</a></li>
            ))}
          </ul>
        </nav>

        <article className="spec-content">
          <header className="spec-header">
            <nav aria-label="Answer modes" className="spec-modes">
              {ANSWER_MODES.map((option) => (
                <RouteLink key={option} href={MODES[option].path} onNavigate={onNavigate}
                  aria-current={option === mode ? 'page' : undefined}
                  className={clsx('spec-mode-link', option === mode && 'spec-mode-link-current')}>
                  {MODES[option].label}
                </RouteLink>
              ))}
            </nav>
            <p className="spec-eyebrow">Technical specification</p>
            <h2 id="spec-title" ref={heading} tabIndex={-1} className="spec-title">{MODES[mode].label}</h2>
            <p className="spec-lead"><Rich text={spec.lead} /></p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {selectedMode === mode ? (
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
                  <Check className="size-4" aria-hidden="true" /> Selected for your next question
                </span>
              ) : (
                <Button variant="primary" onClick={() => onUseMode(mode)}>
                  Use {MODES[mode].label} for my next question
                </Button>
              )}
            </div>
          </header>

          <Section id="overview" title="At a glance">
            <dl className="spec-glance">
              {spec.glance.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd><Rich text={value} /></dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section id="architecture" title="Architecture">
            <p className="spec-note">The request path, from your browser to the index and back through the grounding gate.</p>
            <FlowDiagram nodes={spec.flow} />
          </Section>

          <Section id="lifecycle" title="Request lifecycle">
            <ol className="spec-steps">
              {spec.lifecycle.map((step) => (
                <li key={step.title}>
                  <h4>{step.title}</h4>
                  <p><Rich text={step.body} /></p>
                </li>
              ))}
            </ol>
          </Section>

          <Section id="configuration" title="Configuration">
            {spec.configuration.map((group) => (
              <div key={group.title} className="spec-table-group">
                <h4><Rich text={group.title} /></h4>
                <p className="spec-file">Defined in <code>{group.file}</code></p>
                <Table head={['Setting', 'Value']} rows={group.rows} />
              </div>
            ))}
          </Section>

          <Section id="documents" title="Documents from SharePoint">
            <p className="spec-note"><Rich text={DOCUMENTS.lead} /></p>
            <ol className="spec-steps">
              {DOCUMENTS.pipeline.map((step) => (
                <li key={step.title}>
                  <h4>{step.title}</h4>
                  <p><Rich text={step.body} /></p>
                </li>
              ))}
            </ol>
            <div className="spec-table-group">
              <h4>SharePoint sites</h4>
              <p className="spec-file">Defined in <code>config/institutions.csv</code></p>
              <p className="spec-note">
                Example sites; each deployment registers its own. The sync reads every document library on each site,
                and members of the Entra groups listed for a site see its reports in the app.
              </p>
              <div className="spec-table-wrap">
                <table className="spec-table">
                  <thead>
                    <tr><th scope="col">Institution</th><th scope="col">Site</th></tr>
                  </thead>
                  <tbody>
                    {SITES.map((site) => (
                      <tr key={site.url}>
                        <th scope="row">{site.name}</th>
                        <td><a href={site.url} target="_blank" rel="noopener noreferrer">{site.url}</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="spec-table-group">
              <h4>Sync settings</h4>
              <p className="spec-file">Defined in <code>src/function_app/rag/sync.py</code> and <code>config/institutions.csv</code></p>
              <Table head={['Setting', 'Value']} rows={DOCUMENTS.settings} />
            </div>
          </Section>

          <Section id="scale" title="Scaling to 100 institution sites">
            <p className="spec-note"><Rich text={SCALE.lead} /></p>
            <Table head={['Aspect', 'How it works']} rows={SCALE.rows} />
          </Section>

          <Section id="prompts" title="Prompts">
            {spec.prompts.map((prompt) => (
              <figure key={prompt.title} className="spec-prompt">
                <figcaption>
                  <span className="font-semibold text-slate-800">{prompt.title}</span>
                  <code>{prompt.file}</code>
                </figcaption>
                <pre>{prompt.text}</pre>
              </figure>
            ))}
            <p className="spec-note"><Rich text={spec.promptNote} /></p>
          </Section>

          <Section id="citations" title="Citations and verification">
            <Bullets items={spec.citations} />
          </Section>

          <Section id="conversation" title="Conversation and data handling">
            <Bullets items={spec.conversation} />
          </Section>

          <Section id="permissions" title="Who sees what">
            <Bullets items={DOCUMENTS.access} />
          </Section>

          <Section id="access" title="Identity and access">
            <p className="spec-note">Every service-to-service call uses Microsoft Entra ID; the function key is the only secret.</p>
            <Table head={['Caller', 'Target', 'Role or credential', 'Used for']} rows={spec.identities} />
          </Section>

          <Section id="setup" title="Deployment setup">
            <p className="spec-note"><Rich text={ROLLOUT.lead} /></p>
            <Table head={['Step', 'Who', 'What']} rows={ROLLOUT.rows} />
          </Section>

          <Section id="diagnostics" title="Diagnostics and telemetry">
            <p className="spec-note">Shown under <strong>How this answer was found</strong> below each answer.</p>
            <Bullets items={spec.observability} />
          </Section>

          <Section id="tradeoffs" title="Strengths and limitations">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="spec-card">
                <h4>Strengths</h4>
                <Bullets items={spec.strengths} />
              </div>
              <div className="spec-card">
                <h4>Limitations</h4>
                <Bullets items={spec.limitations} />
              </div>
            </div>
          </Section>

          <Section id="comparison" title="Compare the modes">
            <Table
              head={['', MODES.direct.label, MODES.agent.label]}
              rows={COMPARISON}
              highlight={mode === 'direct' ? 1 : 2}
              rowHeaders
            />
          </Section>

          <footer className="spec-footer">
            <RouteLink href={MODES[other].path} onNavigate={onNavigate} className="spec-footer-link">
              How {MODES[other].label} works
            </RouteLink>
            <RouteLink href="/" onNavigate={onNavigate} className="spec-footer-link">
              Back to research
            </RouteLink>
          </footer>
        </article>
      </div>
    </main>
  );
}

/** Text with `code` spans. Rendered as text nodes, never as HTML. */
function Rich({ text }: { text: string }) {
  return <>{text.split(/`([^`]+)`/).map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}</>;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="spec-section">
      <h3 id={`${id}-title`}>{title}</h3>
      {children}
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="spec-bullets">
      {items.map((item) => <li key={item}><Rich text={item} /></li>)}
    </ul>
  );
}

function Table({ head, rows, highlight, rowHeaders = false }: {
  head: string[];
  rows: string[][];
  highlight?: number;
  rowHeaders?: boolean;
}) {
  return (
    <div className="spec-table-wrap">
      <table className="spec-table">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={index} scope="col" className={clsx(index === highlight && 'spec-highlight')}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.join('|')}>
              {row.map((cell, index) => {
                const content = <Rich text={cell} />;
                return index === 0 && rowHeaders
                  ? <th key={index} scope="row">{content}</th>
                  : <td key={index} className={clsx(index === highlight && 'spec-highlight')}>{content}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlowDiagram({ nodes }: { nodes: Spec['flow'] }) {
  return (
    <ol aria-label="Request path" className="spec-flow">
      {nodes.map((node, index) => (
        <li key={node.name} className={clsx('spec-flow-node', `spec-flow-${node.tone}`)}>
          <span className="spec-flow-number" aria-hidden="true">{index + 1}</span>
          <div className="min-w-0">
            <p className="spec-flow-name">{node.name}</p>
            <p className="spec-flow-detail"><Rich text={node.detail} /></p>
            {node.steps && (
              <ol aria-label={`Inside ${node.name}`} className="spec-flow-steps">
                {node.steps.map((step) => <li key={step}><Rich text={step} /></li>)}
              </ol>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
