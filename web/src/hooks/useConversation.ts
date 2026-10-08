import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, ask } from '../api';
import { toHistory } from '../lib/answer';
import { turnMode } from '../lib/modes';
import type { AnswerMode, Turn } from '../types';

const STORAGE_KEY = 'osfi-rag.conversation.v1';

function restore(): { turns: Turn[]; warning: string | null } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(saved)) throw new Error('Invalid saved conversation.');
    const turns = (saved as Turn[])
      .filter((turn) => typeof turn?.id === 'string' && typeof turn.question === 'string')
      .map((turn) => (turn.status === 'pending' ? { ...turn, status: 'stopped' as const } : turn));
    return {
      turns,
      warning: turns.length === saved.length ? null : 'Some saved messages could not be restored in this browser.',
    };
  } catch {
    return { turns: [], warning: 'The saved conversation could not be restored. Browser storage may be unavailable or damaged.' };
  }
}

function persist(turns: Turn[]): string | null {
  try {
    const settled = turns.filter((turn) => turn.status !== 'pending');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settled));
    return null;
  } catch {
    return 'This conversation could not be saved to browser storage. You can keep chatting, but recent messages may be lost if you reload or close this tab.';
  }
}

export function useConversation() {
  const [restored] = useState(restore);
  const [turns, setTurns] = useState<Turn[]>(restored.turns);
  const [storageWarning, setStorageWarning] = useState<string | null>(restored.warning);
  const controllers = useRef(new Map<string, AbortController>());
  const busy = turns.some((turn) => turn.status === 'pending');

  useEffect(() => {
    if (restored.warning && turns === restored.turns) return;
    setStorageWarning(persist(turns));
  }, [restored, turns]);

  const update = useCallback((id: string, patch: Partial<Turn>) => {
    setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)));
  }, []);

  const run = useCallback(
    async (turn: Turn, previous: readonly Turn[]) => {
      const controller = new AbortController();
      controllers.current.set(turn.id, controller);
      try {
        const response = await ask(turn.question, toHistory(previous), turnMode(turn), controller.signal);
        update(turn.id, { status: 'done', response, error: undefined });
      } catch (error) {
        if (controller.signal.aborted) update(turn.id, { status: 'stopped' });
        else
          update(turn.id, {
            status: 'error',
            error: error instanceof ApiError ? error.message : 'Something went wrong. Try again.',
          });
      } finally {
        controllers.current.delete(turn.id);
      }
    },
    [update],
  );

  const send = useCallback(
    (question: string, mode: AnswerMode) => {
      const text = question.trim();
      if (!text || busy) return;
      const turn: Turn = { id: crypto.randomUUID(), question: text, askedAt: Date.now(), status: 'pending', mode };
      setTurns((current) => [...current, turn]);
      void run(turn, turns);
    },
    [busy, run, turns],
  );

  const retry = useCallback(
    (id: string) => {
      const index = turns.findIndex((turn) => turn.id === id);
      const turn = turns[index];
      if (!turn || busy) return;
      // A retry asks the same mode again, even when an older API answered in direct mode.
      const restarted: Turn = {
        ...turn, status: 'pending', askedAt: Date.now(), error: undefined, response: undefined, mode: turn.mode ?? 'direct',
      };
      update(id, restarted);
      void run(restarted, turns.slice(0, index));
    },
    [busy, run, turns, update],
  );

  const stop = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort();
  }, []);

  const reset = useCallback(() => {
    stop();
    setTurns([]);
  }, [stop]);

  return { turns, busy, send, retry, stop, reset, storageWarning };
}
