import { ArrowLeft, Library, PanelRightOpen, SquarePen } from 'lucide-react';
import type { ReactNode } from 'react';
import { RouteLink } from '../hooks/useRoute';
import { Button } from './ui';

export function Header({ children }: { children: ReactNode }) {
  return (
    <header className="app-header">
      <a className="osfi-brand" href="https://www.osfi-bsif.gc.ca/en" target="_blank" rel="noopener noreferrer"
        aria-label="OSFI, Office of the Superintendent of Financial Institutions (opens in a new tab)">
        <span className="osfi-symbol">
          <img src="/osfi-logo.svg" alt="OSFI / BSIF" width="29" height="50" />
        </span>
        <span className="osfi-name">
          Office of the Superintendent
          <br />
          of Financial Institutions
        </span>
      </a>
      <div className="header-product">
        <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">Annual report research</h1>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
          <span className="inline-block size-1.5 rounded-full bg-brand-600" aria-hidden="true" />
          Research preview
        </div>
      </div>
      <nav aria-label="Workspace" className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
        {children}
      </nav>
    </header>
  );
}

interface WorkspaceNavProps {
  documentCount: number | null;
  libraryOpen: boolean;
  canReset: boolean;
  sourcesCollapsed: boolean;
  onToggleLibrary: () => void;
  onRestoreSources: () => void;
  onNewChat: () => void;
}

export function WorkspaceNav({
  documentCount, libraryOpen, canReset, sourcesCollapsed, onToggleLibrary, onRestoreSources, onNewChat,
}: WorkspaceNavProps) {
  return (
    <>
      {sourcesCollapsed && (
        <Button variant="outline" onClick={onRestoreSources} aria-label="Show source panel"
          aria-controls="source-panel" aria-expanded={false}>
          <PanelRightOpen className="size-4" aria-hidden="true" />
          <span className="hidden xl:inline">Show sources</span>
        </Button>
      )}
      <Button
        variant="ghost"
        onClick={onToggleLibrary}
        aria-pressed={libraryOpen}
        aria-controls="source-panel"
        aria-expanded={libraryOpen}
        aria-label={documentCount === null ? 'Library' : `Library, ${documentCount} reports`}
        className={libraryOpen ? 'bg-slate-100 text-slate-900' : undefined}
      >
        <Library className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">Library</span>
        {documentCount !== null && (
          <span className="hidden rounded bg-slate-100 px-1.5 text-[11px] font-semibold tabular-nums text-slate-600 sm:inline">
            {documentCount}
          </span>
        )}
      </Button>
      <Button variant="primary" onClick={onNewChat} disabled={!canReset} aria-label="New chat">
        <SquarePen className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">New chat</span>
      </Button>
    </>
  );
}

export function BackToResearch({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <RouteLink href="/" onNavigate={onNavigate} className="header-back">
      <ArrowLeft className="size-4" aria-hidden="true" />
      <span className="hidden sm:inline">Back to research</span>
      <span className="sm:hidden">Back</span>
    </RouteLink>
  );
}
