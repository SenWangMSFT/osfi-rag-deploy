// Shapes returned by the Function App (src/function_app/function_app.py).

/** direct: the API queries the knowledge base, which writes the answer. agent: the Foundry agent answers. */
export type AnswerMode = 'direct' | 'agent';

export interface Citation {
  n: number;
  ref_id: string;
  label: string;
  doc_title: string | null;
  institution: string | null;
  fiscal_year: string | null;
  page_from: number | null;
  page_to: number | null;
  source_file: string | null;
  /** The SharePoint document /api/docs streams. */
  document_id: string | null;
  link: string | null;
  citation_url: string | null;
  doc_key: string | null;
  reranker_score: number | null;
  excerpt: string | null;
  bounding_polygons: string | null;
}

export interface ActivityStage {
  type: string;
  elapsed_ms?: number | null;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  count?: number | null;
  query?: string | null;
  status?: string | null;
  error?: unknown;
}

export interface AgentRun {
  name: string | null;
  version: string | null;
  model: string | null;
  response_id: string | null;
  status: string | null;
  tool_calls: number;
}

export interface Diagnostics {
  mode?: AnswerMode;
  elapsed_ms: number;
  retrieve_status: number;
  gate_passed: boolean;
  reference_count: number;
  citation_count: number;
  uncited_reference_count: number;
  unresolved_ref_ids: string[];
  incomplete_ref_ids: string[];
  grounded_sentence_ratio: number | null;
  sentences_total: number;
  sentences_grounded: number;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  answer_raw?: string;
  activity?: ActivityStage[];
  agent?: AgentRun;
  conversation?: {
    history_messages_received: number;
    history_messages_used: number;
    history_messages_omitted: number;
    estimated_input_tokens: number;
    token_budget: number;
  } | null;
}

export interface AskResponse {
  /** Missing from older APIs, which only had the direct mode. */
  mode?: AnswerMode;
  answer: string;
  citations: Citation[];
  warnings: string[];
  diagnostics: Diagnostics;
}

export interface LibraryDocument {
  /** The document ID /api/docs accepts. */
  file: string;
  title: string;
  institution: string | null;
  fiscal_year: string | null;
  size_bytes: number | null;
  last_modified: string | null;
  chunks: number;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

export type TurnStatus = 'pending' | 'done' | 'error' | 'stopped';

export interface Turn {
  id: string;
  question: string;
  askedAt: number;
  status: TurnStatus;
  /** The mode the question was sent with; missing on turns saved before modes existed. */
  mode?: AnswerMode;
  response?: AskResponse;
  error?: string;
}

export type PanelTarget =
  | { kind: 'citation'; turnId: string; n: number }
  | { kind: 'document'; file: string; fromLibrary?: boolean }
  | { kind: 'library' };
