import { BookOpen, CircleAlert, ExternalLink, LockKeyhole, ShieldCheck, X } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { Button, containModalFocus, IconButton } from './ui';

export function ResponsibleAiDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    element.showModal();
    return () => element.close();
  }, [open]);

  return (
    <dialog ref={dialog} aria-labelledby="responsible-ai-title" className="responsible-ai-dialog"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else containModalFocus(event);
      }}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-700">Transparency &amp; responsible AI</p>
            <h2 id="responsible-ai-title" className="mt-2 text-xl font-semibold tracking-tight text-slate-900">
              About this AI-assisted workspace
            </h2>
          </div>
          <IconButton label="Close responsible AI information" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
        <div className="mt-6 space-y-5 text-sm leading-6 text-slate-600">
          <section className="flex gap-3">
            <CircleAlert className="mt-1 size-4 shrink-0 text-brand-700" aria-hidden="true" />
            <div>
              <h3 className="font-semibold text-slate-900">AI-generated answers can be wrong</h3>
              <p>Answers may be inaccurate, incomplete, or misinterpret a report. Check the original cited pages before
                relying on any figure or conclusion. Matching a citation to a passage is not a fact check.</p>
            </div>
          </section>
          <section className="flex gap-3">
            <BookOpen className="mt-1 size-4 shrink-0 text-brand-700" aria-hidden="true" />
            <div>
              <h3 className="font-semibold text-slate-900">Research support, not a decision-maker</h3>
              <p>This proof of concept uses indexed annual reports. Its answers are not official OSFI guidance,
                financial advice, or supervisory decisions. Human review and professional judgment remain essential.</p>
            </div>
          </section>
          <section className="flex gap-3">
            <LockKeyhole className="mt-1 size-4 shrink-0 text-brand-700" aria-hidden="true" />
            <div>
              <h3 className="font-semibold text-slate-900">Share information thoughtfully</h3>
              <p>Do not enter personal, confidential, or protected information. Questions and conversation context are
                sent to the configured AI services. This conversation is saved in this browser; New chat clears that
                local history, not service-side logs.</p>
            </div>
          </section>
          <section className="flex gap-3">
            <ShieldCheck className="mt-1 size-4 shrink-0 text-brand-700" aria-hidden="true" />
            <div>
              <h3 className="font-semibold text-slate-900">Microsoft Responsible AI</h3>
              <p>Microsoft's principles cover fairness, reliability and safety, privacy and security, inclusiveness,
                transparency, and accountability. This preview is not a certification of compliance.</p>
              <a href="https://www.microsoft.com/en-us/ai/responsible-ai" target="_blank" rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 font-medium text-brand-700 underline underline-offset-4">
                Read Microsoft's Responsible AI principles
                <ExternalLink className="size-3" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </div>
          </section>
        </div>
        <div className="mt-7 flex justify-end border-t border-slate-200 pt-5">
          <Button variant="primary" onClick={onClose}>Back to research</Button>
        </div>
      </div>
    </dialog>
  );
}
