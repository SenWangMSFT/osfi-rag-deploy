import type { AnswerMode, Turn } from '../types';

export const ANSWER_MODES: readonly AnswerMode[] = ['direct', 'agent'];

export const MODES: Record<AnswerMode, { label: string; short: string; summary: string; path: string }> = {
  direct: {
    label: 'Direct retrieval',
    short: 'Direct',
    summary: 'The API queries the Foundry IQ knowledge base, which plans the search and writes the answer.',
    path: '/how-it-works/direct',
  },
  agent: {
    label: 'Foundry Agent',
    short: 'Agent',
    summary: 'A Foundry agent decides how to search the knowledge base with its Foundry IQ tool and writes the answer.',
    path: '/how-it-works/agent',
  },
};

export function isAnswerMode(value: unknown): value is AnswerMode {
  return value === 'direct' || value === 'agent';
}

/** The mode that produced an answer; before it arrives, the mode it was requested with. */
export function turnMode(turn: Turn): AnswerMode {
  if (turn.response) return isAnswerMode(turn.response.mode) ? turn.response.mode : 'direct';
  return isAnswerMode(turn.mode) ? turn.mode : 'direct';
}
