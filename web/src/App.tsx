import * as Tooltip from '@radix-ui/react-tooltip';
import { ArrowDown } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, isAbort, listDocuments } from './api';
import { Composer, type ComposerHandle } from './components/Composer';
import { EmptyState } from './components/EmptyState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Footer } from './components/Footer';
import { BackToResearch, Header, WorkspaceNav } from './components/Header';
import { ResponsibleAiDialog } from './components/ResponsibleAiDialog';
import { SourcePanel } from './components/SourcePanel';
import { TurnView } from './components/TurnView';
import { Button } from './components/ui';
import { useAnswerMode } from './hooks/useAnswerMode';
import { useConversation } from './hooks/useConversation';
import { useRoute } from './hooks/useRoute';
import type { AnswerMode, LibraryDocument, PanelTarget } from './types';

// Loaded on first visit, so the specifications don't add to the research workspace's bundle.
const SpecPage = lazy(() => import('./components/SpecPage').then((module) => ({ default: module.SpecPage })));

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export default function App() {
  const { turns, busy, send, retry, stop, reset, storageWarning } = useConversation();
  const [route, navigate] = useRoute();
  const [mode, setMode] = useAnswerMode();
  const [documents, setDocuments] = useState<LibraryDocument[] | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelTarget | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);

  const navigatePanel = useCallback((target: PanelTarget | null) => {
    setPanel(target);
    setPanelCollapsed(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    listDocuments(controller.signal).then(setDocuments, (error: unknown) => {
      if (isAbort(error)) return;
      setDocumentsError(error instanceof ApiError ? error.message : 'Could not load the library.');
    });
    return () => controller.abort();
  }, []);

  useLayoutEffect(() => {
    const element = scrollArea.current;
    if (element && followLatest.current) element.scrollTop = element.scrollHeight;
  }, [turns, panelCollapsed, route.page]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('dialog:modal') || route.page !== 'workspace') return;
      if (event.key === 'Escape') navigatePanel(null);
      else if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isTyping(event.target)) {
        event.preventDefault();
        composer.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigatePanel, route.page]);

  const openCitation = useCallback((turnId: string, n: number) => navigatePanel({ kind: 'citation', turnId, n }), [navigatePanel]);
  const sendQuestion = useCallback((question: string) => {
    followLatest.current = true;
    send(question, mode);
  }, [send, mode]);

  const chooseModeFromSpec = (next: AnswerMode) => {
    setMode(next);
    navigate('/');
  };

  const newChat = () => {
    followLatest.current = true;
    reset();
    setPanel((current) => (current?.kind === 'citation' ? null : current));
    setAwayFromLatest(false);
    composer.current?.focus();
  };

  const panelTurn = panel?.kind === 'citation' ? turns.find((turn) => turn.id === panel.turnId) : undefined;
  const indexedCount = documents ? documents.filter((document) => document.chunks > 0).length : null;

  const workspace = (
    <div className="workspace">
      <main id="main-content" aria-label="Conversation" tabIndex={-1} className="conversation-pane">
        {storageWarning && (
          <p role="alert" className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            {storageWarning}
          </p>
        )}
        <div ref={scrollArea} className="conversation-scroll" onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
          followLatest.current = atBottom;
          setAwayFromLatest(!atBottom);
        }}>
          {turns.length === 0 ? (
            <EmptyState
              documentsError={documentsError}
              onAsk={sendQuestion}
              onNavigate={navigate}
            />
          ) : (
            <div className="conversation-feed">
              {turns.map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  canRetry={!busy}
                  activeCitation={!panelCollapsed && panel?.kind === 'citation' && panel.turnId === turn.id ? panel.n : null}
                  documentCount={indexedCount}
                  onOpenCitation={openCitation}
                  onRetry={retry}
                  onNavigate={navigate}
                />
              ))}
            </div>
          )}
        </div>
        {awayFromLatest && turns.length > 0 && (
          <div className="relative z-10 flex h-0 justify-center">
            <button type="button" className="jump-to-latest" onClick={() => {
              followLatest.current = true;
              scrollArea.current?.scrollTo({
                top: scrollArea.current.scrollHeight,
                behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
              });
            }}>
              <ArrowDown className="size-3.5" aria-hidden="true" /> Latest message
            </button>
          </div>
        )}
        <Composer ref={composer} busy={busy} hasConversation={turns.length > 0}
          mode={mode} onModeChange={setMode} onNavigate={navigate}
          onSubmit={sendQuestion} onStop={stop} onAbout={() => setAboutOpen(true)} />
      </main>
      {panel && (
        <SourcePanel
          target={panel}
          turn={panelTurn}
          documents={documents}
          documentsError={documentsError}
          collapsed={panelCollapsed}
          onCollapse={() => setPanelCollapsed(true)}
          onNavigate={navigatePanel}
        />
      )}
    </div>
  );

  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={150}>
      <div className="app-shell">
        <a href="#main-content" className="skip-link">
          {route.page === 'spec' ? 'Skip to specification' : 'Skip to conversation'}
        </a>
        <Header>
          {route.page === 'spec' ? (
            <BackToResearch onNavigate={navigate} />
          ) : (
            <WorkspaceNav
              documentCount={indexedCount}
              libraryOpen={panel?.kind === 'library' && !panelCollapsed}
              canReset={turns.length > 0}
              sourcesCollapsed={panel !== null && panelCollapsed}
              onRestoreSources={() => setPanelCollapsed(false)}
              onToggleLibrary={() => navigatePanel(panel?.kind === 'library' && !panelCollapsed ? null : { kind: 'library' })}
              onNewChat={newChat}
            />
          )}
        </Header>
        {route.page === 'spec' ? (
          <ErrorBoundary
            resetKey={route.mode}
            fallback={
              <main id="main-content" tabIndex={-1} className="spec-page">
                <div role="alert" className="mx-auto flex max-w-xl flex-col items-start gap-3 px-7 py-10 text-sm text-slate-700">
                  <p>The specification couldn't be loaded. The app may have been updated since you opened it.</p>
                  <Button onClick={() => window.location.reload()}>Reload the page</Button>
                </div>
              </main>
            }
          >
            <Suspense
              fallback={
                <main id="main-content" tabIndex={-1} aria-busy="true" className="spec-page">
                  <span className="sr-only">Loading the specification</span>
                </main>
              }
            >
              <SpecPage mode={route.mode} selectedMode={mode} onNavigate={navigate} onUseMode={chooseModeFromSpec} />
            </Suspense>
          </ErrorBoundary>
        ) : workspace}
        <Footer onAbout={() => setAboutOpen(true)} />
        <ResponsibleAiDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      </div>
    </Tooltip.Provider>
  );
}
