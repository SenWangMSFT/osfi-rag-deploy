import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { AnswerMode } from '../types';
import { ModeSwitch } from './ModeSwitch';

// Matches the API's limit (MAX_QUESTION_CHARS in function_app.py).
const MAX_LENGTH = 2000;

export interface ComposerHandle {
  focus: () => void;
}

interface Props {
  ref?: Ref<ComposerHandle>;
  busy: boolean;
  hasConversation: boolean;
  mode: AnswerMode;
  onModeChange: (mode: AnswerMode) => void;
  onNavigate: (path: string) => void;
  onSubmit: (question: string) => void;
  onStop: () => void;
  onAbout: () => void;
}

export function Composer({
  ref, busy, hasConversation, mode, onModeChange, onNavigate, onSubmit, onStop, onAbout,
}: Props) {
  const [value, setValue] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0 && !busy;

  useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }), []);
  useEffect(() => textarea.current?.focus(), []);

  // Grow with the text up to about eight lines.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 208)}px`;
  }, [value]);

  const submit = () => {
    if (!canSend) return;
    onSubmit(value.trim());
    setValue('');
  };

  return (
    <div className="composer-wrap">
      <form
        className="mx-auto max-w-3xl"
        aria-label="Ask the annual reports"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="composer-box">
          <label htmlFor="question" className="sr-only">
            Ask a question about the annual reports
          </label>
          <textarea
            id="question"
            ref={textarea}
            rows={1}
            value={value}
            maxLength={MAX_LENGTH}
            placeholder={hasConversation ? 'Ask a follow-up question...' : 'Ask about the annual reports...'}
            aria-describedby="answer-disclaimer"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            className="max-h-52 min-h-12 w-full resize-none bg-transparent px-1 py-2 text-[15px] leading-6 text-slate-900 outline-none placeholder:text-slate-500"
          />
          <div className="@container">
            <div className="flex items-center justify-between gap-3 pt-2">
              <ModeSwitch mode={mode} onChange={onModeChange} onNavigate={onNavigate} />
              <div className="flex items-center gap-3">
                <span className="hidden text-[10px] text-slate-500 @xl:inline">
                  <kbd>Enter</kbd> to send <span className="mx-1">/</span> <kbd>Shift + Enter</kbd> new line
                </span>
                {busy ? (
                  <button
                    type="button"
                    onClick={onStop}
                    aria-label="Stop"
                    title="Stop"
                    className="composer-send"
                  >
                    <Square className="size-3.5 fill-current" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!canSend}
                    aria-label="Ask"
                    title="Ask (Enter)"
                    className="composer-send"
                  >
                    <ArrowUp className="size-5" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        <p id="answer-disclaimer" className="mt-2.5 text-center text-[11px] leading-5 text-slate-500">
          AI-generated answers may be wrong. Verify the original sources.{' '}
          <button type="button" onClick={onAbout} className="underline decoration-slate-300 underline-offset-2 hover:text-brand-700">
            About this preview
          </button>
        </p>
      </form>
    </div>
  );
}
