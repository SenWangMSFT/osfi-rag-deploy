import type { AskResponse, Citation, HistoryMessage, Turn } from '../types';

const MARKER = /\[(\d{1,3})\](?!\()/g;
const FIGURE = /\d[\d,]*(?:\.\d+)?/g;
// A sentence ends at . ! or ?, optionally followed by its citation markers.
const SENTENCE_BREAK = /\n+|(?<=[.!?](?:\[\d{1,3}\])*)\s+/;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Rewrites [n] markers as #cite-n links so the Markdown renderer can turn them into citation chips. */
export function linkCitations(answer: string, known: ReadonlySet<number>): string {
  return answer.replace(MARKER, (marker, digits: string) =>
    known.has(Number(digits)) ? `[${digits}](#cite-${digits})` : marker,
  );
}

export function citationNumber(href: string | undefined): number | null {
  const match = href?.match(/^#cite-(\d{1,3})$/);
  return match ? Number(match[1]) : null;
}

export function stripCitations(text: string): string {
  return text.replace(/[ \t]*\[\d{1,3}\](?!\()/g, '');
}

/**
 * Figures such as 13.5 or 98,748 from the sentences that cite source n. The UI finds and highlights
 * them in that source's passage. Years and small integers (dates, footnote numbers) are skipped.
 */
export function citedFigures(answer: string, n: number): string[] {
  const marker = `[${n}]`;
  const figures = new Set<string>();
  // "2024. [2]" -> "2024.[2]", so a marker after the full stop stays with its sentence.
  const attached = answer.replace(/([.!?])[ \t]+((?:\[\d{1,3}\])+)/g, '$1$2');
  for (const sentence of attached.split(SENTENCE_BREAK)) {
    if (!sentence.includes(marker)) continue;
    for (const raw of sentence.replace(/\[\d{1,3}\]/g, ' ').match(FIGURE) ?? []) {
      const figure = raw.replace(/[,.]+$/, '');
      if (isDistinctive(figure)) figures.add(figure);
    }
  }
  return [...figures];
}

function isDistinctive(figure: string): boolean {
  if (/[.,]/.test(figure)) return true;
  const value = Number(figure);
  return value >= 100 && !(value >= 1900 && value <= 2100);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches any of the figures as a whole number: 13.5 matches "13.5%" but not "113.5" or "13.55". */
export function figurePattern(figures: readonly string[], flags = ''): RegExp | null {
  if (figures.length === 0) return null;
  const alternatives = [...figures].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![\\d.,])(?:${alternatives.join('|')})(?!\\d)`, flags);
}

/** Readable one-line text from a chunk's Markdown and HTML tables (cells joined with ·, rows with /). */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/t[dh]>\s*<\/tr>/gi, ' / ')
    .replace(/<\/t[dh]>/gi, ' · ')
    .replace(/<\/(?:p|div|tr|li|h\d|caption)>|<br\s*\/?>/gi, ' / ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (entity, name: string) => ENTITIES[name] ?? entity)
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    // Separators left by empty table cells.
    .replace(/(?:\s*·)+(?=\s*(?:\/|$))/g, '')
    .replace(/(^|\/)(?:\s*·)+/g, '$1')
    .replace(/(?:·\s*){2,}/g, '· ')
    .replace(/(?:\s*\/)+\s*$/, '')
    .replace(/^\s*(?:\/\s*)+/, '')
    .replace(/(?:\s*\/\s*){2,}/g, ' / ')
    .trim();
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

/**
 * A window of the passage around the first cited figure (biased forward, so the figure stays visible when
 * the snippet is line-clamped), or its opening if none is found.
 */
export function makeSnippet(text: string, figures: readonly string[], radius = 110): Snippet {
  const hit = figurePattern(figures)?.exec(text);
  if (!hit) return { before: truncate(text, radius * 2), match: '', after: '' };
  const matchEnd = hit.index + hit[0].length;
  // Widen to whole words on both sides.
  let start = Math.max(0, hit.index - Math.round(radius / 2));
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < hit.index) start = space + 1;
  }
  let end = Math.min(text.length, matchEnd + Math.round(radius * 1.5));
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > matchEnd) end = space;
  }
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, hit.index),
    match: hit[0],
    after: text.slice(matchEnd, end) + (end < text.length ? '…' : ''),
  };
}

function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, length).replace(/\s+\S*$/, '')}…`;
}

/** Splits text into plain and highlighted parts, one highlighted part per cited figure. */
export function highlightParts(text: string, figures: readonly string[]): { text: string; marked: boolean }[] {
  const pattern = figurePattern(figures, 'g');
  if (!pattern) return [{ text, marked: false }];
  const parts: { text: string; marked: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), marked: false });
    parts.push({ text: match[0], marked: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), marked: false });
  return parts;
}

/** Conversation context for the next question: completed turns only, markers removed. */
export function toHistory(turns: readonly Turn[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  for (const turn of turns) {
    if (turn.status !== 'done' || !turn.response) continue;
    messages.push({ role: 'user', text: turn.question });
    const answer = stripCitations(turn.response.answer).trim();
    if (answer) messages.push({ role: 'assistant', text: answer });
  }
  return messages;
}

export function answerAsText(response: AskResponse): string {
  const sources = response.citations.map((citation) => `[${citation.n}] ${citation.label}`);
  return sources.length ? `${response.answer}\n\nSources\n${sources.join('\n')}` : response.answer;
}

export function citationTitle(citation: Citation): string {
  return citation.doc_title ?? citation.source_file ?? 'Source';
}
