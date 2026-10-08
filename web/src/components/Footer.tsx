import { Info } from 'lucide-react';

export function Footer({ onAbout }: { onAbout: () => void }) {
  return (
    <footer className="app-footer">
      <div className="technology-credit">
        <span className="microsoft-mark" aria-hidden="true"><i /><i /><i /><i /></span>
        <span className="text-slate-500">Powered by</span>
        <a href="https://learn.microsoft.com/azure/foundry/what-is-foundry"
          target="_blank" rel="noopener noreferrer">Microsoft Foundry</a>
        <span aria-hidden="true" className="text-slate-300">/</span>
        <a href="https://learn.microsoft.com/azure/foundry/agents/concepts/what-is-foundry-iq"
          target="_blank" rel="noopener noreferrer">Foundry IQ</a>
      </div>
      <button type="button" onClick={onAbout} className="responsible-ai-link">
        <Info className="size-3.5" aria-hidden="true" />
        Responsible AI
      </button>
    </footer>
  );
}
