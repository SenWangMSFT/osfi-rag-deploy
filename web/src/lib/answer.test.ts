import { describe, expect, it } from 'vitest';
import type { AskResponse, Turn } from '../types';
import {
  answerAsText,
  citationNumber,
  citedFigures,
  highlightParts,
  linkCitations,
  makeSnippet,
  plainText,
  stripCitations,
  toHistory,
} from './answer';

// A real answer from the knowledge base.
const ANSWER = [
  'At fiscal year-end **October 31, 2025**:',
  '',
  '- **RBC:** CET1 ratio of **13.5%**.[1]',
  '- **TD:** CET1 ratio of **14.7%**.[2]',
  '',
  '**TD’s CET1 ratio was 1.2 percentage points higher than RBC’s** (14.7% versus 13.5%).[1][2]',
].join('\n');

const TABLE = '<table>\n<tr>\n<td>CET1 ratio</td>\n<td>13.5%</td>\n<td>13.2%</td>\n</tr>\n<tr>\n<td>Tier 1 capital ratio</td>\n<td>15.1%</td>\n</tr>\n</table>\n(1) Capital &amp; RWA use OSFI&#39;s CAR guideline.';

function response(answer: string): AskResponse {
  return {
    answer,
    citations: [],
    warnings: [],
    diagnostics: {} as AskResponse['diagnostics'],
  };
}

describe('linkCitations', () => {
  it('turns known markers into citation links, including adjacent ones after punctuation', () => {
    expect(linkCitations('Up 5%.[1][2] Down.[3]', new Set([1, 2]))).toBe('Up 5%.[1](#cite-1)[2](#cite-2) Down.[3]');
  });

  it('leaves existing Markdown links alone', () => {
    expect(linkCitations('[1](https://example.com)', new Set([1]))).toBe('[1](https://example.com)');
  });

  it('round-trips through citationNumber', () => {
    expect(citationNumber('#cite-12')).toBe(12);
    expect(citationNumber('https://example.com/#cite-1')).toBeNull();
    expect(citationNumber(undefined)).toBeNull();
  });
});

describe('citedFigures', () => {
  it('collects figures from the sentences that cite each source', () => {
    expect(citedFigures(ANSWER, 1)).toEqual(['13.5', '1.2', '14.7']);
    expect(citedFigures(ANSWER, 2)).toEqual(['14.7', '1.2', '13.5']);
  });

  it('skips years, dates and footnote numbers but keeps large amounts', () => {
    expect(citedFigures('In 2025, on October 31, net income was $16,240 million and 450 branches opened.[1]', 1)).toEqual([
      '16,240',
      '450',
    ]);
  });

  it('does not bleed figures across sentences on one line', () => {
    expect(citedFigures('RBC reported 13.5%.[1] TD reported 14.7%.[2]', 1)).toEqual(['13.5']);
  });

  it('keeps a marker that follows the full stop after a space with its sentence', () => {
    const answer = 'Diluted EPS was $11.44, up from $9.51. [2] Net income rose 19%. [1]';
    expect(citedFigures(answer, 2)).toEqual(['11.44', '9.51']);
    expect(citedFigures(answer, 1)).toEqual([]);
  });
});

describe('plainText', () => {
  it('flattens HTML tables and decodes entities', () => {
    expect(plainText(TABLE)).toBe(
      "CET1 ratio · 13.5% · 13.2% / Tier 1 capital ratio · 15.1% / (1) Capital & RWA use OSFI's CAR guideline.",
    );
  });

  it('drops figure placeholders and Markdown syntax', () => {
    expect(plainText('## Highlights\n![](figures/1.2 "Photo of a branch")**Net income** grew.')).toBe(
      'Highlights Net income grew.',
    );
  });

  it('skips empty table cells', () => {
    const table = '<table><tr><td>Capital ratios (1)</td><td></td><td></td></tr><tr><td></td><td>CET1</td><td>13.5%</td></tr></table>';
    expect(plainText(table)).toBe('Capital ratios (1) / CET1 · 13.5%');
  });
});

describe('makeSnippet', () => {
  it('shows the first cited figure early in the window', () => {
    const text = `${'word '.repeat(60)}CET1 ratio · 13.5% · 13.2% ${'more '.repeat(60)}`.trim();
    const snippet = makeSnippet(text, ['13.5'], 40);
    expect(snippet.match).toBe('13.5');
    expect(snippet.before).toBe('…word CET1 ratio · ');
    expect(snippet.after.startsWith('% · 13.2%')).toBe(true);
    expect(snippet.after.endsWith('…')).toBe(true);
  });

  it('does not match inside longer numbers', () => {
    expect(makeSnippet('113.5 and 13.55 and 13.5%', ['13.5']).before).toBe('113.5 and 13.55 and ');
  });

  it('splits every cited figure out for highlighting', () => {
    expect(highlightParts('EPS $11.44, up from $9.51 (11.440)', ['11.44', '9.51'])).toEqual([
      { text: 'EPS $', marked: false },
      { text: '11.44', marked: true },
      { text: ', up from $', marked: false },
      { text: '9.51', marked: true },
      { text: ' (11.440)', marked: false },
    ]);
    expect(highlightParts('none', [])).toEqual([{ text: 'none', marked: false }]);
  });

  it('falls back to the opening text', () => {
    expect(makeSnippet('No figures here.', ['99.9'])).toEqual({ before: 'No figures here.', match: '', after: '' });
  });
});

describe('toHistory', () => {
  const turn = (question: string, answer: string | null, status: Turn['status'] = 'done'): Turn => ({
    id: question,
    question,
    askedAt: 0,
    status,
    response: answer === null ? undefined : response(answer),
  });

  it('keeps completed turns only and strips citation markers', () => {
    const history = toHistory([turn('q1', 'CET1 was 13.5%.[1]'), turn('q2', null, 'error'), turn('q3', 'Yes [2].')]);
    expect(history).toEqual([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'CET1 was 13.5%.' },
      { role: 'user', text: 'q3' },
      { role: 'assistant', text: 'Yes.' },
    ]);
  });

  it('keeps all completed exchanges rather than a fixed number of messages', () => {
    const turns = Array.from({ length: 40 }, (_, index) => turn(`question ${index}`, `answer ${index}`));
    expect(toHistory(turns)).toHaveLength(80);
    expect(toHistory(turns)[0]).toEqual({ role: 'user', text: 'question 0' });
    expect(toHistory(turns).at(-1)).toEqual({ role: 'assistant', text: 'answer 39' });
    expect(toHistory([turn('a', 'x'), turn('b', ''), turn('c', 'y'), turn('d', 'z')])[0]?.role).toBe('user');
  });

  it('strips markers from the answer text used for copy', () => {
    expect(stripCitations('A [1] b.[2]')).toBe('A b.');
    expect(answerAsText({ ...response('A.[1]'), citations: [{ n: 1, label: 'RBC — p. 1' } as never] })).toBe(
      'A.[1]\n\nSources\n[1] RBC — p. 1',
    );
  });
});
