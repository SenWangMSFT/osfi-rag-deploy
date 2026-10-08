import { clsx } from 'clsx';
import { Bot, Info, Workflow, type LucideIcon } from 'lucide-react';
import { RouteLink } from '../hooks/useRoute';
import { ANSWER_MODES, MODES } from '../lib/modes';
import type { AnswerMode } from '../types';

const ICONS: Record<AnswerMode, LucideIcon> = { direct: Workflow, agent: Bot };

interface Props {
  mode: AnswerMode;
  onChange: (mode: AnswerMode) => void;
  onNavigate: (path: string) => void;
}

/** Chooses how the next question is answered. Earlier answers keep the mode they were produced with. */
export function ModeSwitch({ mode, onChange, onNavigate }: Props) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <fieldset className="mode-switch">
        <legend className="sr-only">Answer mode</legend>
        {ANSWER_MODES.map((option) => {
          const Icon = ICONS[option];
          return (
            <label key={option} className={clsx('mode-option', mode === option && 'mode-option-selected')}
              title={MODES[option].summary}>
              <input type="radio" name="answer-mode" value={option} checked={mode === option}
                aria-label={MODES[option].label} onChange={() => onChange(option)} className="mode-input" />
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden @sm:inline">{MODES[option].label}</span>
              <span className="@sm:hidden">{MODES[option].short}</span>
            </label>
          );
        })}
      </fieldset>
      <RouteLink href={MODES[mode].path} onNavigate={onNavigate} className="mode-help"
        aria-label={`How ${MODES[mode].label} works`} title={`How ${MODES[mode].label} works`}>
        <Info className="size-3.5" aria-hidden="true" />
      </RouteLink>
    </div>
  );
}
