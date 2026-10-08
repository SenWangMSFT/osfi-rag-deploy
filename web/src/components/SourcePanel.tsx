import { clsx } from 'clsx';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Info,
  Library,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  PanelRight,
  RotateCcw,
  TextQuote,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { documentHref } from '../api';
import { useDocumentUrl } from '../hooks/useDocumentUrl';
import { citationTitle, citedFigures } from '../lib/answer';
import { formatBytes, formatCount, pageLabel } from '../lib/format';
import type { LibraryDocument, PanelTarget, Turn } from '../types';
import { ErrorBoundary } from './ErrorBoundary';
import { InstitutionMark } from './InstitutionMark';
import { Button, containModalFocus, IconButton, IconLink } from './ui';

// The passage view pulls in an HTML parser and sanitizer, so it loads on first use.
const Passage = lazy(() => import('./Passage').then((module) => ({ default: module.Passage })));

interface Props {
  target: PanelTarget;
  turn: Turn | undefined;
  documents: LibraryDocument[] | null;
  documentsError: string | null;
  collapsed: boolean;
  onCollapse: () => void;
  onNavigate: (target: PanelTarget | null) => void;
}

type Axis = 'width' | 'height';
const PANEL_INSET = 20;
const LIMITS = { width: { min: 32, max: 64 }, height: { min: 45, max: 100 } };

/** Right-hand panel: the cited PDF page and passage, a whole report, or the library. */
export function SourcePanel({ target, turn, documents, documentsError, collapsed, onCollapse, onNavigate }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const drag = useRef<{ axis: Axis; start: number; size: number; available: number } | null>(null);
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const [size, setSize] = useState({ width: 44, height: 100 });
  const [expanded, setExpanded] = useState(false);
  const [resizing, setResizing] = useState(false);
  const close = () => onNavigate(null);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const update = () => setDesktop(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || collapsed) return;
    const previousFocus = document.activeElement;
    if (desktop) element.show();
    else element.showModal();
    element.focus({ preventScroll: true });
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && previousFocus.getClientRects().length > 0) {
        previousFocus.focus({ preventScroll: true });
      } else document.getElementById('question')?.focus({ preventScroll: true });
    };
  }, [collapsed, desktop]);

  const resize = (axis: Axis, value: number) => {
    setSize((current) => ({ ...current, [axis]: Math.min(LIMITS[axis].max, Math.max(LIMITS[axis].min, value)) }));
  };

  const startResize = (event: PointerEvent<HTMLDivElement>, axis: Axis) => {
    if (event.button !== 0) return;
    const parent = dialog.current?.parentElement;
    if (!parent) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      axis,
      start: axis === 'width' ? event.clientX : event.clientY,
      size: size[axis],
      available: axis === 'width' ? parent.clientWidth : parent.clientHeight - PANEL_INSET * 2,
    };
    setResizing(true);
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.available <= 0) return;
    const position = current.axis === 'width' ? event.clientX : event.clientY;
    const delta = ((position - current.start) / current.available) * 100;
    resize(current.axis, current.size + (current.axis === 'width' ? -delta : delta));
  };

  const stopResize = () => { drag.current = null; setResizing(false); };
  const keyResize = (event: KeyboardEvent<HTMLDivElement>, axis: Axis) => {
    const increase = axis === 'width' ? 'ArrowLeft' : 'ArrowDown';
    const decrease = axis === 'width' ? 'ArrowRight' : 'ArrowUp';
    const values: Record<string, number> = {
      [increase]: size[axis] + 2, [decrease]: size[axis] - 2,
      Home: LIMITS[axis].min, End: LIMITS[axis].max,
    };
    const value = values[event.key];
    if (value === undefined) return;
    event.preventDefault();
    resize(axis, value);
  };

  let content: ReactNode = null;
  if (target.kind === 'library') {
    content = (
      <LibraryView
        documents={documents}
        error={documentsError}
        onOpen={(file) => onNavigate({ kind: 'document', file, fromLibrary: true })}
      />
    );
  } else if (target.kind === 'document') {
    content = (
      <DocumentView
        file={target.file}
        info={documents?.find((item) => item.file === target.file)}
        onBack={target.fromLibrary ? () => onNavigate({ kind: 'library' }) : undefined}
      />
    );
  } else if (turn?.response) {
    content = (
      <CitationView
        key={turn.id}
        turn={turn}
        n={target.n}
        onSelect={(n) => onNavigate({ kind: 'citation', turnId: turn.id, n })}
      />
    );
  }
  if (!content) return null;
  const height = expanded ? 100 : size.height;

  return (
      <dialog
        ref={dialog}
        id="source-panel"
        tabIndex={-1}
        aria-label="Source viewer"
        aria-modal={!desktop && !collapsed ? true : undefined}
        className="source-panel"
        data-resizing={resizing}
        data-expanded={expanded}
        style={{
          width: `${expanded ? 64 : size.width}%`,
          height: `calc(${height}% - ${PANEL_INSET * 2 * height / 100}px)`,
        }}
        onCancel={(event) => { event.preventDefault(); close(); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else containModalFocus(event);
        }}
        onClick={(event) => {
          if (desktop || event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
        }}
      >
        <div className="source-panel-toolbar">
          <span className="flex items-center gap-2 text-[11px] font-semibold text-slate-600">
            <PanelRight className="size-3.5 text-brand-700" aria-hidden="true" /> Source explorer
          </span>
          <div className="flex items-center gap-0.5">
            <IconButton label="Collapse source panel" onClick={onCollapse}>
              <Minus className="size-4" aria-hidden="true" />
            </IconButton>
            {desktop && (
              <IconButton label={expanded ? 'Restore source panel size' : 'Expand source panel'}
                aria-pressed={expanded} onClick={() => setExpanded((current) => !current)}>
                {expanded ? <Minimize2 className="size-3.5" aria-hidden="true" /> : <Maximize2 className="size-3.5" aria-hidden="true" />}
              </IconButton>
            )}
            <IconButton label="Close source panel (Esc)" onClick={close}>
              <X className="size-4" aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        <div className="source-panel-content">
          <ErrorBoundary
            resetKey={JSON.stringify(target)}
            fallback={
              <PanelMessage
                icon={<TriangleAlert className="size-5" />}
                title="This source couldn't be displayed"
                action={<Button onClick={close}>Close</Button>}
              />
            }
          >
            {content}
          </ErrorBoundary>
        </div>
        {desktop && !expanded && (['width', 'height'] as const).map((axis) => (
          <div key={axis} role="separator" tabIndex={0} aria-label={`Resize source panel ${axis}`}
            aria-orientation={axis === 'width' ? 'vertical' : 'horizontal'}
            aria-controls="source-panel"
            aria-valuemin={LIMITS[axis].min} aria-valuemax={LIMITS[axis].max}
            aria-valuenow={Math.round(size[axis])}
            aria-valuetext={`${Math.round(size[axis])}% of ${axis === 'height' ? 'available height' : 'workspace'}`}
            title={`Drag to resize ${axis}, or use arrow keys. Home for smallest; End for largest.`}
            className={`source-resize source-resize-${axis}`}
            onPointerDown={(event) => startResize(event, axis)}
            onPointerMove={moveResize}
            onPointerUp={stopResize}
            onPointerCancel={stopResize}
            onLostPointerCapture={stopResize}
            onKeyDown={(event) => keyResize(event, axis)} />
        ))}
      </dialog>
  );
}

function CitationView({
  turn,
  n,
  onSelect,
}: {
  turn: Turn;
  n: number;
  onSelect: (n: number) => void;
}) {
  const [tab, setTab] = useState<'page' | 'passage'>('page');
  const { answer, citations } = turn.response!;
  const index = Math.max(0, citations.findIndex((citation) => citation.n === n));
  const citation = citations[index];
  const figures = useMemo(() => (citation ? citedFigures(answer, citation.n) : []), [answer, citation]);
  if (!citation) return null;

  const title = citationTitle(citation);
  const page = pageLabel(citation.page_from, citation.page_to);
  const previous = citations[index - 1];
  const next = citations[index + 1];

  return (
    <>
      <PanelHeader
        mark={<InstitutionMark name={citation.institution ?? title} />}
        title={title}
        subtitle={[citation.institution, citation.fiscal_year && `Fiscal ${citation.fiscal_year}`, page]
          .filter(Boolean)
          .join(' · ')}
        actions={
          citation.document_id && (
            <IconLink label="Open the PDF in a new tab" href={documentHref(citation.document_id, citation.page_from)}>
              <ExternalLink className="size-4" aria-hidden="true" />
            </IconLink>
          )
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-slate-200 px-3 sm:px-4">
        <div role="tablist" aria-label="View" className="flex gap-1" onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const nextTab = event.key === 'Home' ? 'page' : event.key === 'End' ? 'passage' : tab === 'page' ? 'passage' : 'page';
          setTab(nextTab);
          document.getElementById(`source-tab-${nextTab}`)?.focus();
        }}>
          <Tab id="source-tab-page" controls="source-view-page" selected={tab === 'page'} onClick={() => setTab('page')} icon={FileText}>
            Page
          </Tab>
          <Tab id="source-tab-passage" controls="source-view-passage" selected={tab === 'passage'} onClick={() => setTab('passage')} icon={TextQuote}>
            Passage
          </Tab>
        </div>
        {citations.length > 1 && (
          <div className="ml-auto flex items-center gap-0.5 text-xs text-slate-500">
            <IconButton label="Previous source" disabled={!previous} onClick={() => previous && onSelect(previous.n)}>
              <ChevronLeft className="size-4" aria-hidden="true" />
            </IconButton>
            <span className="px-1 tabular-nums">
              Source {citation.n} of {citations.length}
            </span>
            <IconButton label="Next source" disabled={!next} onClick={() => next && onSelect(next.n)}>
              <ChevronRight className="size-4" aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {/* Hidden rather than unmounted, so switching tabs doesn't reload the PDF. */}
        <div id="source-view-page" role="tabpanel" aria-labelledby="source-tab-page" tabIndex={0}
          hidden={tab !== 'page'} className="absolute inset-0">
          {citation.document_id ? (
            <PdfFrame file={citation.document_id} page={citation.page_from} label={`${title}, ${page}`} />
          ) : (
            <PanelMessage icon={<TriangleAlert className="size-5" />} title="No PDF for this source" />
          )}
        </div>
        {tab === 'passage' && (
          <div id="source-view-passage" role="tabpanel" aria-labelledby="source-tab-passage" tabIndex={0}
            className="absolute inset-0 overflow-y-auto bg-white px-4 py-4 sm:px-5">
            <p className="mb-4 flex items-start gap-2 rounded-lg bg-brand-50/60 p-3 text-xs leading-5 text-slate-600 ring-1 ring-inset ring-brand-100">
              <Info className="mt-0.5 size-3.5 shrink-0 text-brand-500" aria-hidden="true" />
              <span>
                The exact passage the answer was written from, extracted from {page}.
                {figures.length > 0 && ' Figures quoted in the answer are highlighted.'}
              </span>
            </p>
            <Suspense
              fallback={
                <div className="space-y-2.5" aria-hidden="true">
                  {['w-full', 'w-11/12', 'w-4/5'].map((width) => (
                    <div key={width} className={clsx('skeleton h-3 rounded-full', width)} />
                  ))}
                </div>
              }
            >
              <Passage markdown={citation.excerpt ?? ''} figures={figures} />
            </Suspense>
          </div>
        )}
      </div>
    </>
  );
}

function DocumentView({
  file,
  info,
  onBack,
}: {
  file: string;
  info: LibraryDocument | undefined;
  onBack?: () => void;
}) {
  const title = info?.title ?? file;
  const status = info && (info.chunks > 0 ? `${formatCount(info.chunks)} passages indexed` : 'Not indexed');
  return (
    <>
      <PanelHeader
        onBack={onBack}
        mark={<InstitutionMark name={info?.institution ?? title} />}
        title={title}
        subtitle={[info?.institution, info?.fiscal_year && `Fiscal ${info.fiscal_year}`, status].filter(Boolean).join(' · ')}
        actions={
          <IconLink label="Open the PDF in a new tab" href={documentHref(file)}>
            <ExternalLink className="size-4" aria-hidden="true" />
          </IconLink>
        }
      />
      <div className="relative min-h-0 flex-1">
        <PdfFrame file={file} page={1} label={title} />
      </div>
    </>
  );
}

function LibraryView({
  documents,
  error,
  onOpen,
}: {
  documents: LibraryDocument[] | null;
  error: string | null;
  onOpen: (file: string) => void;
}) {
  const indexed = documents?.filter((item) => item.chunks > 0) ?? [];
  const passages = indexed.reduce((sum, item) => sum + item.chunks, 0);
  return (
    <>
      <PanelHeader
        mark={
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600">
            <Library className="size-4" aria-hidden="true" />
          </span>
        }
        title="Library"
        subtitle={
          documents
            ? `${indexed.length} of ${documents.length} reports indexed · ${formatCount(passages)} passages`
            : 'Loading…'
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <PanelMessage icon={<TriangleAlert className="size-5" />} title="Couldn't load the library">
            {error}
          </PanelMessage>
        ) : documents === null ? (
          <ul className="divide-y divide-slate-100" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((key) => (
              <li key={key} className="flex items-center gap-3 px-4 py-3.5">
                <span className="skeleton size-8 rounded-lg" />
                <span className="flex-1 space-y-2">
                  <span className="skeleton block h-3 w-2/3 rounded-full" />
                  <span className="skeleton block h-2.5 w-1/3 rounded-full" />
                </span>
              </li>
            ))}
          </ul>
        ) : documents.length === 0 ? (
          <PanelMessage icon={<Library className="size-5" />} title="No reports available">
            Reports will appear here when they have been added to the library.
          </PanelMessage>
        ) : (
          <ul className="divide-y divide-slate-100">
            {documents.map((item) => (
              <li key={item.file}>
                <button
                  type="button"
                  onClick={() => onOpen(item.file)}
                  className="group flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
                >
                  <InstitutionMark name={item.institution ?? item.title} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">{item.title}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {[item.institution, item.fiscal_year && `Fiscal ${item.fiscal_year}`, formatBytes(item.size_bytes)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {item.chunks > 0 ? (
                    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium tabular-nums text-emerald-700 ring-1 ring-inset ring-emerald-200">
                      {formatCount(item.chunks)} passages
                    </span>
                  ) : (
                    <span
                      title="The indexer couldn't process this file, so it can't be cited."
                      className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200"
                    >
                      Not indexed
                    </span>
                  )}
                  <ChevronRight
                    className="size-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-slate-100 px-4 py-4 text-xs leading-5 text-slate-500">
          Read the original reports behind this workspace. Only indexed reports can be cited in answers.
        </p>
      </div>
    </>
  );
}

function PdfFrame({ file, page, label }: { file: string; page: number | null; label: string }) {
  const { url, error, retry } = useDocumentUrl(file);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);

  if (error) {
    return (
      <PanelMessage
        icon={<TriangleAlert className="size-5" />}
        title="Couldn't open the PDF"
        action={
          <Button onClick={retry}>
            <RotateCcw className="size-3.5" aria-hidden="true" /> Try again
          </Button>
        }
      >
        {error}
      </PanelMessage>
    );
  }

  return (
    <div className="absolute inset-0 bg-slate-100">
      {url && (
        // Same URL with a new #page jumps within the loaded PDF instead of downloading it again.
        <iframe
          key={url}
          src={`${url}#page=${page ?? 1}&navpanes=0&view=FitH`}
          title={label}
          onLoad={() => setLoadedUrl(url)}
          className="size-full border-0"
        />
      )}
      {(!url || loadedUrl !== url) && (
        <div className="absolute inset-0 grid place-items-center bg-slate-50">
          <div className="flex flex-col items-center gap-3 text-sm text-slate-500">
            <LoaderCircle className="size-5 animate-spin text-brand-600" aria-hidden="true" />
            Opening {page && page > 1 ? pageLabel(page) : 'the report'}…
          </div>
        </div>
      )}
    </div>
  );
}

function PanelHeader({
  mark,
  title,
  subtitle,
  actions,
  onBack,
}: {
  mark: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  onBack?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-3 py-3.5 sm:px-4">
      {onBack && (
        <IconButton label="Back to the library" onClick={onBack} className="-mr-1">
          <ChevronLeft className="size-4.5" aria-hidden="true" />
        </IconButton>
      )}
      {mark}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-900" title={title}>
          {title}
        </p>
        {subtitle && <p className="truncate text-xs text-slate-500">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

function Tab({
  id,
  controls,
  selected,
  onClick,
  icon: Icon,
  children,
}: {
  id: string;
  controls: string;
  selected: boolean;
  onClick: () => void;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      id={id}
      role="tab"
      aria-controls={controls}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onClick}
      className={clsx(
        'relative inline-flex items-center gap-1.5 px-2.5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/50',
        selected ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800',
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {children}
      {selected && <span className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-brand-600" />}
    </button>
  );
}

function PanelMessage({
  icon,
  title,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto grid size-10 place-items-center rounded-full bg-slate-100 text-slate-500">{icon}</div>
        <p className="mt-3 text-sm font-semibold text-slate-900">{title}</p>
        {children && <p className="mt-1 text-sm leading-6 text-slate-500">{children}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}
