import type { HistoryMessage } from '../types';

// Keep in sync with web/server.mjs and rag/conversation.py.
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

/** The API applies the model's token budget; the browser only bounds transport size. */
export function prepareAskRequest(
  question: string,
  history: readonly HistoryMessage[],
  maxBytes = MAX_REQUEST_BYTES,
  fields: Record<string, string> = {},
) {
  let bytes = encoder.encode(JSON.stringify({ question, history: [], ...fields })).length;
  if (bytes > maxBytes) throw new RangeError('The question exceeds the request size limit.');
  let start = history.length;

  while (start > 0) {
    let groupStart = start - 1;
    while (groupStart > 0 && history[groupStart].role !== 'user') groupStart--;
    if (history[groupStart].role !== 'user') break;
    const exchange = history.slice(groupStart, start);
    const extra = exchange.reduce((total, message) => total + encoder.encode(JSON.stringify(message)).length, 0)
      + exchange.length - 1 + (start < history.length ? 1 : 0);
    if (bytes + extra > maxBytes) break;
    bytes += extra;
    start = groupStart;
  }

  return {
    body: JSON.stringify({ question, history: history.slice(start), ...fields }),
    omittedMessages: start,
    sentMessages: history.length - start,
  };
}
