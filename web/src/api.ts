import type { AnswerMode, AskResponse, HistoryMessage, LibraryDocument } from './types';
import { prepareAskRequest } from './lib/conversation';

// All calls are same-origin: the Vite dev server or web/server.mjs proxies /api to the Function App, adding the
// signed-in user's search token.

const SIGN_IN_CODES = new Set(['sign_in_required', 'token_expired', 'invalid_token']);

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function request<T>(path: string, init: RequestInit = {}, mode?: AnswerMode, retried = false): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError('Could not reach the service. Check your connection and try again.', 0);
  }
  const data: unknown = await response.json().catch(() => null);
  if (response.status === 401 && !retried && signInCode(data) === 'token_expired' && (await refreshSignIn())) {
    return request<T>(path, init, mode, true);
  }
  if (!response.ok) throw new ApiError(describeFailure(response.status, data, mode), response.status);
  return data as T;
}

function signInCode(data: unknown): string | null {
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' && SIGN_IN_CODES.has(data.code)
    ? data.code
    : null;
}

/** App Service authentication renews the stored tokens; there's nothing to refresh when running locally. */
async function refreshSignIn(): Promise<boolean> {
  try {
    return (await fetch('/.auth/refresh', { credentials: 'same-origin' })).ok;
  } catch {
    return false;
  }
}

function describeFailure(status: number, data: unknown, mode?: AnswerMode): string {
  const detail =
    data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : null;
  switch (status) {
    case 400:
      return detail ?? 'The request was not valid.';
    case 401:
      return signInCode(data)
        ? (detail ?? 'Sign in to use this app.')
        : 'The app is not authorized to call the API. Check the function key the server uses.';
    case 403:
      return 'The app is not authorized to call the API. Check the function key the server uses.';
    case 404:
      return detail ?? 'Not found.';
    case 413:
      return 'The connected server cannot accept this much conversation history. Update the API and web proxy, or start a new chat.';
    case 502:
    case 503:
      return mode === 'agent'
        ? 'The Foundry agent is not responding right now. Try again in a moment, or switch to Direct retrieval.'
        : 'The knowledge base is not responding right now. Try again in a moment.';
    case 504:
      return 'The answer took too long. Try again, or ask a narrower question.';
    default:
      return detail ?? `Something went wrong (HTTP ${status}).`;
  }
}

export async function ask(
  question: string,
  history: HistoryMessage[],
  mode: AnswerMode = 'direct',
  signal?: AbortSignal,
): Promise<AskResponse> {
  const prepared = prepareAskRequest(question, history, undefined, { mode });
  const response = await request<AskResponse>('/api/ask', { method: 'POST', body: prepared.body, signal }, mode);
  const warnings = [...response.warnings];
  if (mode === 'agent' && response.mode !== 'agent') {
    warnings.push(
      'The connected API does not support Foundry Agent mode yet, so Direct retrieval answered instead. Update the API to use the agent.',
    );
  }
  if (prepared.omittedMessages > 0) {
    warnings.push(
      `Conversation context: ${prepared.omittedMessages} earlier messages were left out of this request to fit the transport limit. They remain in your chat.`,
    );
  }
  if (prepared.sentMessages > 6 && !response.diagnostics.conversation) {
    warnings.push(
      'Extended conversation context is not enabled in the connected API yet. Update the API to include messages beyond the last three exchanges.',
    );
  }
  return { ...response, warnings };
}

export async function listDocuments(signal?: AbortSignal): Promise<LibraryDocument[]> {
  const data = await request<{ documents: LibraryDocument[] }>('/api/documents', { signal });
  return data.documents;
}

/** A same-origin URL the API streams the PDF from, reused while the viewer switches pages. */
export async function documentUrl(file: string): Promise<string> {
  const data = await request<{ url: string }>(`/api/docs/${encodeURIComponent(file)}?format=json`);
  return data.url;
}

/** Link that opens the PDF in a new tab at the cited page. */
export function documentHref(file: string, page?: number | null): string {
  return `/api/docs/${encodeURIComponent(file)}${page ? `#page=${page}` : ''}`;
}
