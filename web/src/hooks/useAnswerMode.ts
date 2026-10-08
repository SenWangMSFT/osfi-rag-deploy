import { useCallback, useState } from 'react';
import { isAnswerMode } from '../lib/modes';
import type { AnswerMode } from '../types';

const STORAGE_KEY = 'osfi-rag.mode.v1';

export function useAnswerMode(): [AnswerMode, (mode: AnswerMode) => void] {
  const [mode, setMode] = useState<AnswerMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return isAnswerMode(saved) ? saved : 'direct';
    } catch {
      return 'direct';
    }
  });
  const update = useCallback((next: AnswerMode) => {
    setMode(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Remembering the choice is a convenience; the selected mode still applies to this session.
    }
  }, []);
  return [mode, update];
}
