import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskResponse, HistoryMessage } from '../types';
import { ask } from '../api';
import { MAX_REQUEST_BYTES, prepareAskRequest } from './conversation';

const history: HistoryMessage[] = [
  { role: 'user', text: 'First question' },
  { role: 'assistant', text: 'First answer' },
  { role: 'user', text: 'Latest question' },
  { role: 'assistant', text: 'Latest answer' },
];
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('prepareAskRequest', () => {
  it('keeps all messages, including payloads larger than the old 64 KiB proxy cap', () => {
    const messages: HistoryMessage[] = Array.from({ length: 50 }, (_, index) => [
      { role: 'user' as const, text: `Question ${index}` },
      { role: 'assistant' as const, text: 'The reported capital ratio is 13.5%. '.repeat(100) },
    ]).flat();
    const prepared = prepareAskRequest('Follow up.', messages);
    expect(bytes(prepared.body)).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(prepared.body).history).toEqual(messages);
    expect(prepared.omittedMessages).toBe(0);
    expect(prepared.sentMessages).toBe(100);
    expect(bytes(prepared.body)).toBeLessThan(MAX_REQUEST_BYTES);
  });

  it('trims only whole oldest exchanges at the exact serialized byte boundary', () => {
    const question = 'Next?';
    const exact = bytes(JSON.stringify({ question, history: history.slice(2) }));
    const prepared = prepareAskRequest(question, history, exact);
    expect(bytes(prepared.body)).toBe(exact);
    expect(JSON.parse(prepared.body)).toEqual({ question, history: history.slice(2) });
    expect(prepared.omittedMessages).toBe(2);
    expect(JSON.parse(prepareAskRequest(question, history, exact - 1).body).history).toEqual([]);
  });

  it('counts UTF-8 and escaped characters, rather than JavaScript string length', () => {
    const messages: HistoryMessage[] = [
      ...history,
      { role: 'user', text: 'Compare "A"\nwith B \\ C' },
      { role: 'assistant', text: 'Caf\u00e9 \u4f60\u597d \ud83d\ude00'.repeat(20) },
    ];
    const exact = bytes(JSON.stringify({ question: 'Why?', history: messages.slice(4) }));
    const prepared = prepareAskRequest('Why?', messages, exact);
    expect(bytes(prepared.body)).toBe(exact);
    expect(JSON.parse(prepared.body).history).toEqual(messages.slice(4));
    expect(prepared.omittedMessages).toBe(4);
  });

  it('never splits a large answer or substitutes older context for a dropped recent exchange', () => {
    const messages: HistoryMessage[] = [...history, { role: 'user', text: 'Large' }, { role: 'assistant', text: 'x'.repeat(2000) }];
    const prepared = prepareAskRequest('Keep this question.', messages, 500);
    expect(JSON.parse(prepared.body)).toEqual({ question: 'Keep this question.', history: [] });
    expect(prepared.omittedMessages).toBe(6);
  });

  it('rejects a question that cannot fit rather than silently shortening it', () => {
    expect(() => prepareAskRequest('x'.repeat(200), [], 100)).toThrow('question exceeds');
  });
});

describe('extended API compatibility', () => {
  afterEach(() => vi.unstubAllGlobals());

  const response: AskResponse = {
    answer: 'A research answer.', citations: [], warnings: [],
    diagnostics: {
      elapsed_ms: 10, retrieve_status: 200, gate_passed: false, reference_count: 0, citation_count: 0,
      uncited_reference_count: 0, unresolved_ref_ids: [], incomplete_ref_ids: [], grounded_sentence_ratio: null,
      sentences_total: 1, sentences_grounded: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    },
  };

  it('warns when the UI is still connected to an older API that only takes six messages', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetch);
    const result = await ask('Next?', [...history, ...history]);
    expect(JSON.parse(fetch.mock.calls[0][1].body).history).toHaveLength(8);
    expect(result.warnings).toContainEqual(expect.stringContaining('not enabled in the connected API'));
  });

  it('accepts the updated API and preserves its budget warning', async () => {
    const updated: AskResponse = {
      ...response,
      warnings: ['Conversation context: older messages were left out.'],
      diagnostics: {
        ...response.diagnostics,
        conversation: {
          history_messages_received: 8, history_messages_used: 6, history_messages_omitted: 2,
          estimated_input_tokens: 100, token_budget: 100,
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(updated))));
    expect(await ask('Next?', [...history, ...history])).toEqual(updated);
  });
});
