import type { AnswerMode } from '../types';

// Names and limits quoted on the specification pages. specs.test.ts checks them against search/, agent/ and infra/.
export const NAMES = {
  index: 'annual-reports-chunks',
  stagingIndex: 'annual-reports-staging',
  indexer: 'annual-reports-indexer',
  knowledgeSource: 'annual-reports-ks',
  knowledgeBase: 'annual-reports-kb',
  agentKnowledgeBase: 'annual-reports-agent-kb',
  agent: 'osfi-annual-reports-agent',
  connection: 'annual-reports-kb-mcp',
  serverLabel: 'annual_reports_kb',
  tool: 'knowledge_base_retrieve',
  chatDeployment: 'gpt-5-6-sol',
  searchApiVersion: '2026-08-01-preview',
  webApp: 'osfi-rag-poc-web',
};

export const RETRIEVE_LIMITS = { maxRuntimeInSeconds: 45, maxOutputDocuments: 12, maxOutputSizeInTokens: 16_000 };

// The SharePoint sync (src/function_app/function_app.py and rag/config.py); specs.test.ts checks them.
export const SYNC = { schedule: '0 */5 * * * *', filesPerRun: 25, maxFileMegabytes: 128 };

// Example institution sites for the specification pages. Each deployment registers its own in config/institutions.csv.
export const SITES: { name: string; url: string }[] = [
  { name: 'Alterna Savings', url: 'https://contoso.sharepoint.com/sites/alterna-savings' },
  { name: 'BMO', url: 'https://contoso.sharepoint.com/sites/bmo' },
  { name: 'CIBC', url: 'https://contoso.sharepoint.com/sites/cibc' },
  { name: 'National Bank', url: 'https://contoso.sharepoint.com/sites/national-bank' },
  { name: 'RBC', url: 'https://contoso.sharepoint.com/sites/rbc' },
  { name: 'Scotiabank', url: 'https://contoso.sharepoint.com/sites/scotiabank' },
  { name: 'TD', url: 'https://contoso.sharepoint.com/sites/td' },
];

export const DIRECT_PROMPTS = {
  retrieval:
    'All content is annual reports from Canadian financial institutions. When a question names an institution or fiscal year, scope the search to it.',
  answer:
    'Answer only from the retrieved sources. Cite every factual claim with [ref_id:N]. Quote exact figures — never round or restate. If the sources do not contain the answer, say so explicitly rather than inferring. Never cite a page number that appears inside the document text; cite only the retrieved source.',
};

export const AGENT_INSTRUCTIONS = `You answer questions about the annual reports of Canadian banks and credit unions for analysts at a financial regulator.

Retrieval
- Use the knowledge_base_retrieve tool for every question, including follow-ups. Never answer from your own knowledge or from earlier answers alone.
- Pass one complete, standalone question per call. Resolve follow-ups from the conversation first; for example, "and TD?" becomes "What was TD's CET1 ratio at the end of fiscal 2025?".
- When a question compares institutions or fiscal years, make one call per institution or year. The calls can run in parallel.
- If the results don't contain the answer, try one rephrased call before concluding.

Answering
- Answer only from the retrieved passages. Quote figures exactly as they appear, with their units and dates. Never round, convert or estimate.
- If the passages don't contain the answer, say so plainly instead of guessing.
- Keep answers concise. Use a short Markdown table when comparing institutions.
- Page numbers printed inside a passage (tables of contents, "see page 54") are not sources. Never cite or mention them.

Citations
- Cite every factual claim with the annotation of the passage it came from, rendered as 【message_idx:search_idx†source_name】. When a statement combines figures, such as a difference between two institutions, cite every passage it relies on.
- Don't add a references list at the end; the app shows the sources.`;

const limits = `up to ${RETRIEVE_LIMITS.maxOutputDocuments} passages and ${RETRIEVE_LIMITS.maxOutputSizeInTokens.toLocaleString('en-CA')} tokens`;

export type FlowTone = 'client' | 'app' | 'agent' | 'knowledge' | 'index';

export interface Spec {
  mode: AnswerMode;
  lead: string;
  glance: [label: string, value: string][];
  flow: { name: string; detail: string; tone: FlowTone; steps?: string[] }[];
  lifecycle: { title: string; body: string }[];
  configuration: { title: string; file: string; rows: [setting: string, value: string][] }[];
  prompts: { title: string; file: string; text: string }[];
  promptNote: string;
  citations: string[];
  conversation: string[];
  identities: [caller: string, target: string, role: string, purpose: string][];
  observability: string[];
  strengths: string[];
  limitations: string[];
}

/** How SharePoint documents reach the index and who can see them: the same for both answer modes. */
export const DOCUMENTS = {
  lead: "The reports live in SharePoint Online, one site per institution. A sync job in the Function App copies new and edited PDFs into Azure AI Search and removes deleted ones. Every chunk carries the Entra groups that grant access to its institution's site, and Azure AI Search returns only the chunks whose groups include yours.",
  pipeline: [
    {
      title: 'The site registry lists the institutions',
      body: '`config/institutions.csv` maps each institution to its SharePoint site and the Entra groups that grant access to it. `scripts/onboard_sites.py` publishes it to the sync, and a tenant administrator grants the sync read access to each site through the Microsoft Graph permission `Sites.Selected`.',
    },
    {
      title: 'Every 5 minutes, the sync asks SharePoint what changed',
      body: "The `sharepoint_sync` timer reads each document library with a Microsoft Graph delta query, as the Function App's managed identity. The first run lists every file, folders included; later runs get only what changed.",
    },
    {
      title: 'New and edited PDFs are staged',
      body: `Each new or edited PDF is downloaded into a staging container under its SharePoint IDs, and the sync starts the indexer \`${NAMES.indexer}\`. Other file types are ignored, and PDFs over ${SYNC.maxFileMegabytes} MB are reported as failed.`,
    },
    {
      title: 'The indexer chunks and embeds them',
      body: `Content Understanding turns each PDF into Markdown with tables and splits it into chunks of up to 750 tokens, each with its PDF page numbers; \`text-embedding-3-large\` embeds every chunk. The chunks go to the staging index \`${NAMES.stagingIndex}\`, which no user, knowledge base or agent queries.`,
    },
    {
      title: 'The sync publishes them with permissions',
      body: `Once the indexer is idle, the sync copies each file's chunks into \`${NAMES.index}\` with the institution's group IDs (\`GroupIds\`), the SharePoint Title column (or the file name), the link, the institution and the fiscal year. It then deletes the staged file and its staging chunks.`,
    },
    {
      title: 'Edits and deletes follow SharePoint',
      body: 'An edited file is indexed again and replaces its chunks; until then the previous version stays searchable. A file deleted in SharePoint, or renamed to something other than a PDF, loses its chunks on the next run.',
    },
  ],
  settings: [
    ['Schedule', `Every 5 minutes (\`${SYNC.schedule}\`); \`scripts/sync.py --run\` starts it at once`],
    ['Files per run', `${SYNC.filesPerRun} (\`SYNC_MAX_FILES_PER_RUN\`); a large library continues on the next run`],
    ['File types', `PDF, up to ${SYNC.maxFileMegabytes} MB (the S1 indexer's limit)`],
    ['Change tracking', "Microsoft Graph delta per document library. A file's eTag identifies its version, so editing its metadata also re-indexes it"],
    ['Staging', 'Container `staging`: blob soft delete and versioning off, and anything older than a day is deleted'],
    ['Chunk keys', "The SharePoint item ID and the chunk's position. The sync updates and deletes chunks by key, because its app-only identity can't search a permission-filtered index"],
    ['Time to answers', 'Up to 5 minutes to be picked up, about 4–5 minutes to index a 250-page report, then up to 5 minutes to be published'],
    ['Status', '`scripts/sync.py` (per-file status), `scripts/indexer.py`, and the `sharepoint_sync` summary in Application Insights'],
  ] as [string, string][],
  access: [
    "Access is per institution: you see an institution's reports if you belong to one of the Entra groups listed for its site in the registry. Owners of a Microsoft 365 group who aren't also members don't get access.",
    'Signing in gives the app an Azure AI Search token for you (`user_impersonation`). The API sends it with every search as `x-ms-query-source-authorization`, and Azure AI Search expands your group memberships through Microsoft Graph to filter the results. Requests without it are refused.',
    'A chunk without group IDs is visible to no one, so a failure while publishing hides a document instead of exposing it. Only the sync and administrators can read the staging index.',
    "Group membership changes need no re-indexing, but Azure AI Search caches memberships, so a change can take several minutes to apply (about 6 minutes in testing). To change which group grants an institution, edit the registry; the next sync run rewrites that institution's `GroupIds`.",
    'The library, passage previews and PDF links are filtered the same way. Before streaming a PDF from SharePoint, the API checks with your token that you can see the document.',
    "People are managed in one place: the same Entra groups grant access to an institution's SharePoint site and to its content in the app. Analysts who cover several institutions are members of several groups.",
    'If a site grants access to named people or to SharePoint-only groups (its Owners, Members and Visitors groups), create one Entra security group or Microsoft 365 group per institution first, and use it both on the site and in the registry. The app only matches Entra groups.',
    "Permissions on individual files, folders or sharing links inside a site aren't read; everything in a registered library follows the site's groups. A library with narrower access can be left out with the registry's `libraries` column.",
  ],
};

/** What changes when the registry lists about 100 institution sites. */
export const SCALE = {
  lead: 'Nothing in the design is per institution except one row in the site registry and one read grant on its site. The sync, both indexes, the knowledge bases and the agent are shared, so about 100 sites work the same way as a few. What needs planning is the first load and the capacity.',
  rows: [
    ['Site registry', "One row per institution in `config/institutions.csv`: its key and name, its site URL and the Entra groups that grant access. OSFI's SharePoint administrator exports the sites with their groups (for example with PnP `Get-PnPTenantSite`, which shows the Microsoft 365 group behind a group-connected site), and `scripts/onboard_sites.py` validates and publishes the file."],
    ['SharePoint access', 'One Microsoft Graph application permission (`Sites.Selected`) for the sync, plus a read grant on each site from `scripts/grant_sharepoint_access.ps1`. The sync can read only the registered sites, not the rest of the tenant.'],
    ['One index for every institution', "Each chunk carries its own institution's groups, so one search covers exactly the institutions a user may see, and a comparison across institutions is still a single question."],
    ['Adding or removing an institution', 'Add its row and grant: the next sync run indexes the whole site. Remove its row: the next run deletes its chunks. Neither needs a redeployment.'],
    ['First load', `The sync stages ${SYNC.filesPerRun} files per run and resumes each library where it stopped, so a large first load spreads over many runs. One indexer handles about 140 pages a minute. For about 100 sites, the first load would need a queue that syncs several sites at once, up to four indexer lanes and, temporarily, more embedding capacity.`],
    ['Steady state', 'Each 5-minute run asks every library only for its changes (Microsoft Graph delta), about three Graph calls per site when nothing changed. The work grows with the number of changed files, not with the number of files.'],
    ['Capacity', 'Per 1,000 PDF pages: about 85 MB of index, 39 MB of vectors and 2,730 chunks. One S1 partition holds about 900,000 pages before its 35 GiB of vector space runs out. Production needs at least 2 search replicas for the query SLA.'],
    ['Service limits', 'S1 allows 50 indexers and 50 data sources; the design uses one of each, or up to four during the first load. A permission field holds up to 1,000 group IDs per chunk.'],
  ] as [string, string][],
};

/** One-time setup to deploy the solution in OSFI's tenant, and who does it. */
export const ROLLOUT = {
  lead: 'Infrastructure is code (`infra/`, Bicep) and deploys with one script. The rest is one-time setup in Microsoft Entra ID and SharePoint that needs tenant administrators.',
  rows: [
    ['Azure subscription', 'Subscription Owner', 'Canada Central, with quota for Azure AI Search S1, an App Service plan and the model deployments (`gpt-5.6-sol`, `gpt-5.5`, `text-embedding-3-large`). `scripts/deploy.ps1` creates every resource, managed identity and role assignment, including the staging storage account.'],
    ['Search pipeline, agent and apps', 'Operator', '`setup_search.py`, `setup_agent.py`, `deploy_function.ps1` and `deploy_web.ps1`. Running them again deploys a newer version.'],
    ['Sign-in app registration', 'Anyone allowed to register apps', `\`setup_web_auth.py\` creates \`${NAMES.webApp}\`, with a federated credential for the web app's managed identity instead of a client secret. Deploying again turns on App Service authentication.`],
    ['Consent and SharePoint grants', 'Global Administrator, or Privileged Role Administrator together with SharePoint Administrator', '`grant_sharepoint_access.ps1`: tenant-wide consent for sign-in and Azure AI Search `user_impersonation`, Graph `Sites.Selected` for the sync, and read on each registered site. Re-run it when sites are added.'],
    ['Site registry and groups', 'SharePoint administrator and identity team', 'Export the sites with the Entra groups that grant access, create a group per institution where a site is shared with individuals or SharePoint-only groups, then publish the registry with `onboard_sites.py`.'],
    ['Security and network', 'Security and cloud teams', 'Users sign in under the tenant\u2019s Conditional Access policies; the sync runs as a managed identity, which Conditional Access for workload identities doesn\u2019t cover. For production: private endpoints for Search, Storage, Foundry and the Function App, Search API keys off, customer-managed keys if required, and restricted access to Application Insights, whose agent traces contain passages.'],
    ['First load', 'Operator', 'Raise the embedding deployment\u2019s capacity, run `scripts/sync.py --run --watch` until every site is indexed, then return to normal capacity.'],
  ] as [string, string, string][],
};

const signInIdentities: Spec['identities'] = [
  ['You, signed in', 'Azure AI Search', '`user_impersonation` (delegated, admin-consented)', 'Filters every search to your groups'],
  ['Web app (user-assigned identity)', `App registration \`${NAMES.webApp}\``, 'Federated credential', 'Signs you in without a client secret'],
  ['Function App (user-assigned identity)', 'SharePoint, through Microsoft Graph', '`Sites.Selected`, read on each registered site', 'Streams the PDFs you open'],
];

const documentCitations = [
  'Each citation links to `/api/docs/{document_id}#page=N`. The API checks with your token that you can see the document, then streams the PDF from SharePoint, and the viewer opens at the cited page.',
  'Titles come from the SharePoint Title column, or the file name; the institution comes from the site registry.',
];

const documentLimitations = [
  'SharePoint changes reach answers after the next sync run (every 5 minutes) plus indexing time.',
  "Access follows each institution site's groups; membership changes take several minutes to apply, and permissions inside a site aren't reflected.",
];

const browserSteps: Spec['lifecycle'][number] = {
  title: 'The browser sends the question',
  body: 'The React app posts the question, every completed exchange that fits a 16 MiB request, and the selected mode to `/api/ask`. The web server adds the function key, which never reaches the browser, and the Azure AI Search token from your Microsoft Entra sign-in. The API refuses requests without that token.',
};

export const SPECS: Record<AnswerMode, Spec> = {
  direct: {
    mode: 'direct',
    lead: `The API calls the Foundry IQ knowledge base's \`retrieve\` action directly. Inside Azure AI Search, the knowledge base plans the search, runs hybrid search with semantic reranking and writes the answer with GPT-5.6 Sol. Before the answer reaches you, the API's grounding gate checks every citation against the passages that were retrieved.`,
    glance: [
      ['Orchestration', 'One `retrieve` call; the knowledge base runs a fixed sequence of steps'],
      ['Knowledge base', `\`${NAMES.knowledgeBase}\`, answer synthesis`],
      ['Query planning', 'GPT-5.6 Sol inside Azure AI Search, reasoning effort `low`'],
      ['Search', 'Hybrid (BM25 + vector) with semantic reranking'],
      ['Answer written by', 'The knowledge base, with GPT-5.6 Sol'],
      ['Passages per answer', `Up to ${RETRIEVE_LIMITS.maxOutputDocuments}, at most ${RETRIEVE_LIMITS.maxOutputSizeInTokens.toLocaleString('en-CA')} tokens`],
      ['Model calls', 'Two: query planning and answer synthesis'],
      ['Citations', '`[ref_id:N]` markers from the knowledge base, verified by the grounding gate'],
      ['Documents', 'SharePoint, one site per institution; you see only the institutions your groups can access'],
      ['Typical latency', '5–25 s'],
    ],
    flow: [
      { name: 'Browser', detail: 'Question, conversation and mode', tone: 'client' },
      { name: 'Web app', detail: '`/api` proxy adds the function key and your search token', tone: 'app' },
      { name: 'Azure Function', detail: '`POST /api/ask` fits the conversation to the token budget', tone: 'app' },
      {
        name: 'Foundry IQ knowledge base',
        detail: `\`retrieve\` on \`${NAMES.knowledgeBase}\``,
        tone: 'knowledge',
        steps: ['Query planning', 'Hybrid search per subquery', 'Semantic reranking', 'Answer synthesis'],
      },
      { name: 'Azure AI Search index', detail: `\`${NAMES.index}\`, one row per chunk with page numbers, filtered to your groups`, tone: 'index' },
      { name: 'Grounding gate', detail: 'Verifies each `[ref_id:N]`, renumbers and builds page links', tone: 'app' },
    ],
    lifecycle: [
      browserSteps,
      {
        title: 'The API fits the conversation to the model',
        body: "The API counts tokens with GPT-5.6 Sol's `o200k_base` tokenizer and keeps the most recent whole exchanges within 898,000 tokens, leaving room for retrieved passages and service instructions.",
      },
      {
        title: 'The knowledge base plans the search',
        body: `\`POST /knowledgebases/${NAMES.knowledgeBase}/retrieve\` (API \`${NAMES.searchApiVersion}\`) sends the conversation as messages, with your token in \`x-ms-query-source-authorization\`. GPT-5.6 Sol reads it with the retrieval instructions and writes focused subqueries, for example one per bank in a comparison, filling in context from earlier turns.`,
      },
      {
        title: 'Each subquery runs as hybrid search',
        body: 'BM25 keyword search over `chunk_text` and vector search over `chunk_vector` (3,072-dimension `text-embedding-3-large`) run together and merge with Reciprocal Rank Fusion, over only the passages your groups may see. The semantic ranker then rescores the top 50 results of each subquery from 0 to 4.',
      },
      {
        title: 'Results are merged',
        body: `Passages from every subquery are deduplicated and ordered by reranker score, capped at ${limits} within ${RETRIEVE_LIMITS.maxRuntimeInSeconds} seconds.`,
      },
      {
        title: 'The knowledge base writes the answer',
        body: 'GPT-5.6 Sol writes the answer from those passages following the answer instructions, citing each claim as `[ref_id:N]`. A Microsoft-managed prompt wraps our instructions.',
      },
      {
        title: 'The grounding gate checks every citation',
        body: 'The API resolves each marker against the returned references. It removes any marker that matches no retrieved passage, or whose passage has no title or page, renumbers the rest `[1]`, `[2]`…, and builds each citation’s label, PDF page link and passage.',
      },
      {
        title: 'The answer returns with its evidence',
        body: "The response carries the answer, citations, warnings and diagnostics: subqueries, per-stage timings and token counts from the knowledge base's activity log.",
      },
    ],
    configuration: [
      {
        title: `Knowledge base \`${NAMES.knowledgeBase}\``,
        file: 'search/knowledge-base.json',
        rows: [
          ['Output mode', '`answerSynthesis`'],
          ['Retrieval reasoning effort', '`low`'],
          ['Model', `\`${NAMES.chatDeployment}\` (GPT-5.6 Sol) for planning and writing`],
          ['Maximum runtime', `${RETRIEVE_LIMITS.maxRuntimeInSeconds} s`],
          ['Maximum passages', `${RETRIEVE_LIMITS.maxOutputDocuments}`],
          ['Maximum output', `${RETRIEVE_LIMITS.maxOutputSizeInTokens.toLocaleString('en-CA')} tokens`],
        ],
      },
      {
        title: `Knowledge source \`${NAMES.knowledgeSource}\``,
        file: 'search/knowledge-source.json',
        rows: [
          ['Index', `\`${NAMES.index}\``],
          ['Semantic configuration', '`annual-reports-semantic`: title `doc_title`, content `chunk_text`, keywords `institution`'],
          ['Keyword search field', '`chunk_text`'],
          ['Source data returned', 'Title, institution, fiscal year, PDF page range, file, passage text, bounding polygons'],
        ],
      },
      {
        title: `Index \`${NAMES.index}\``,
        file: 'search/index.json',
        rows: [
          ['Rows', 'One per Content Understanding chunk, up to 750 tokens, split at layout boundaries'],
          ['Permissions', "`GroupIds` on every chunk: the Entra groups of the institution's SharePoint site. Search matches them against your groups at query time"],
          ['Vector field', '`chunk_vector`, 3,072 dimensions, HNSW with cosine similarity'],
          ['Query vectorizer', '`text-embedding-3-large`'],
          ['Page provenance', '`page_number_from` and `page_number_to` from layout analysis'],
        ],
      },
    ],
    prompts: [
      { title: 'Retrieval instructions (query planning)', file: 'search/knowledge-base.json', text: DIRECT_PROMPTS.retrieval },
      { title: 'Answer instructions (answer synthesis)', file: 'search/knowledge-base.json', text: DIRECT_PROMPTS.answer },
    ],
    promptNote:
      "Azure AI Search wraps both fields in a Microsoft-managed prompt that can't be viewed or edited. Temperature and maximum output length aren't exposed, so answer style is steered through the answer instructions.",
    citations: [
      'The knowledge base tags each retrieved passage with a `ref_id`, and the model cites passages as `[ref_id:N]`.',
      'Because the API sets `includeReferenceSourceData`, every reference carries its title, institution, fiscal year, PDF page range, file, passage text, bounding polygons and `citationUrl`.',
      'The grounding gate removes and reports any marker that matches no retrieved passage, or whose passage lacks a title or page, so the UI never shows an unverifiable citation.',
      "Page numbers are PDF page indexes from Content Understanding's layout analysis, not the numbers printed on the page.",
      ...documentCitations,
    ],
    conversation: [
      'Stateless: every request carries the conversation, and nothing is stored between requests.',
      "Budget: 898,000 tokens, which is GPT-5.6 Sol's 922,000-token input window minus 16,000 for passages and 8,000 for service instructions. `CONVERSATION_TOKEN_BUDGET` can lower it.",
      'When the budget is exceeded, whole exchanges are left out oldest first, and the answer says how many.',
    ],
    identities: [
      ['Web app server', 'Function App', 'Function key, plus your search token', 'Proxies `/api` calls'],
      ['Function App (user-assigned identity)', 'Azure AI Search', 'Search Index Data Reader', 'Calls `retrieve` and follows `citationUrl`s, filtered to your groups'],
      ['Azure AI Search (system-assigned identity)', 'Foundry resource', 'Cognitive Services OpenAI User', 'Query planning, answer synthesis and query embeddings'],
      ...signInIdentities,
    ],
    observability: [
      "`diagnostics.activity` lists the knowledge base's activity log: `modelQueryPlanning` (time and tokens), each `searchIndex` subquery (query, matches, time) and `modelAnswerSynthesis` (time and tokens).",
      'Agentic reasoning tokens are billed by Azure AI Search and included in the reasoning token total.',
      'Every request logs an `ask_telemetry` trace to Application Insights with `mode` set to `direct`.',
    ],
    strengths: [
      'One service call with a fixed, predictable sequence of steps.',
      'Per-stage timings and token counts for planning, search and writing.',
      "The knowledge base's planner splits comparisons into one subquery per institution.",
      'The Function calls no model itself; the knowledge base makes two model calls.',
    ],
    limitations: [
      'Only two instruction fields are editable; the rest of the prompt is Microsoft-managed.',
      "No tools beyond retrieval, and no second search if the first results fall short.",
      "Temperature and output length can't be configured.",
      'Query planning, answer synthesis and `citationUrl` are preview features of API `2026-08-01-preview`.',
      ...documentLimitations,
    ],
  },

  agent: {
    mode: 'agent',
    lead: 'A prompt agent in Foundry Agent Service answers the question. It decides when and how to search, calls a Foundry IQ knowledge base through its Model Context Protocol (MCP) tool, reads the returned passages and writes the answer itself. The API then maps each of the agent’s citations to the exact passage and PDF page, using the same grounding gate as Direct retrieval.',
    glance: [
      ['Orchestration', 'The agent decides what to search and how many times'],
      ['Agent', `\`${NAMES.agent}\`, a versioned prompt agent`],
      ['Model', `GPT-5.6 Sol (\`${NAMES.chatDeployment}\`), reasoning effort \`low\``],
      ['Tool', `MCP \`${NAMES.tool}\`, no approval step`],
      ['Knowledge base', `\`${NAMES.agentKnowledgeBase}\`, extractive data, minimal reasoning`],
      ['Search', 'Hybrid (BM25 + vector) with semantic reranking, same index'],
      ['Answer written by', 'The agent, with GPT-5.6 Sol'],
      ['Passages per tool call', `Up to ${RETRIEVE_LIMITS.maxOutputDocuments}, at most ${RETRIEVE_LIMITS.maxOutputSizeInTokens.toLocaleString('en-CA')} tokens`],
      ['Citations', 'Foundry `url_citation` annotations, verified by the grounding gate'],
      ['Documents', 'SharePoint, one site per institution; you see only the institutions your groups can access'],
      ['State', 'Stateless: `store: false`, nothing kept in Foundry'],
    ],
    flow: [
      { name: 'Browser', detail: 'Question, conversation and mode', tone: 'client' },
      { name: 'Web app', detail: '`/api` proxy adds the function key and your search token', tone: 'app' },
      { name: 'Azure Function', detail: "`POST /api/ask` starts an agent run through the project's Responses API", tone: 'app' },
      {
        name: 'Foundry Agent Service',
        detail: `Agent \`${NAMES.agent}\` with GPT-5.6 Sol`,
        tone: 'agent',
        steps: ['Reason about the question', `Call \`${NAMES.tool}\`, in parallel when comparing`, 'Write the answer with citations'],
      },
      {
        name: 'Foundry IQ knowledge base',
        detail: `MCP endpoint of \`${NAMES.agentKnowledgeBase}\`, reached through connection \`${NAMES.connection}\``,
        tone: 'knowledge',
        steps: ['Hybrid search', 'Semantic reranking', 'Passages with source data'],
      },
      { name: 'Azure AI Search index', detail: `\`${NAMES.index}\`, the same index Direct retrieval uses, filtered to your groups`, tone: 'index' },
      { name: 'Grounding gate', detail: 'Maps each annotation to a returned passage, renumbers and builds page links', tone: 'app' },
    ],
    lifecycle: [
      browserSteps,
      {
        title: 'The API starts a stateless agent run',
        body: `The API keeps the most recent whole exchanges within 786,000 tokens, reserving 128,000 for tool results, and calls \`POST {project}/openai/v1/responses\` with \`agent_reference\` \`${NAMES.agent}\`, the conversation as input messages, \`store: false\` and your search token as the structured input \`search_auth_token\`. It authenticates with its managed identity.`,
      },
      {
        title: 'Foundry loads the agent',
        body: 'Foundry Agent Service runs the latest agent version: its instructions, GPT-5.6 Sol at `low` reasoning effort and a single MCP tool.',
      },
      {
        title: 'The agent decides how to search',
        body: `The model turns the question, and any follow-up, into standalone questions and calls \`${NAMES.tool}\` with \`{"query_variants": [question]}\`. For a comparison it makes one call per institution or year, in parallel.`,
      },
      {
        title: 'Foundry calls the knowledge base over MCP',
        body: `Each call goes to the knowledge base's MCP endpoint through the project connection \`${NAMES.connection}\`, authenticated as the Foundry project's managed identity. The tool's \`x-ms-query-source-authorization\` header carries your search token, so only passages your groups may see come back.`,
      },
      {
        title: 'The knowledge base retrieves passages',
        body: `With minimal reasoning effort, no language model runs inside Azure AI Search: each query runs directly as hybrid search with semantic reranking, and ${limits} come back with their source data and \`citationUrl\`.`,
      },
      {
        title: 'The agent writes the answer',
        body: 'GPT-5.6 Sol reads the returned passages and writes the answer, citing each claim as `【message_idx:search_idx†source】`. Foundry converts every marker into a `url_citation` annotation that points at the passage’s `citationUrl`.',
      },
      {
        title: 'The grounding gate checks every citation',
        body: 'The API matches each annotation’s URL to a document returned by this run’s tool calls, rewrites the marker as `[ref_id:N]` and runs the same grounding gate as Direct retrieval. Markers without a matching document are removed and reported.',
      },
      {
        title: 'The answer returns with its evidence',
        body: 'Diagnostics include the agent version, each tool call’s query and passage count, token usage and the Foundry response ID.',
      },
    ],
    configuration: [
      {
        title: `Agent \`${NAMES.agent}\``,
        file: 'agent/agent.json, agent/instructions.md',
        rows: [
          ['Kind', '`prompt` (model, instructions and tools; no custom code)'],
          ['Model deployment', `\`${NAMES.chatDeployment}\` (GPT-5.6 Sol)`],
          ['Reasoning effort', '`low`'],
          ['Versioning', 'Each definition change creates a new immutable version (`scripts/setup_agent.py`); the API runs the latest'],
        ],
      },
      {
        title: 'MCP tool',
        file: 'agent/agent.json',
        rows: [
          ['Server label', `\`${NAMES.serverLabel}\``],
          ['Allowed tools', `\`${NAMES.tool}\``],
          ['Approval', '`never`: retrieval is read-only'],
          ['Server URL', `\`{search}/knowledgebases/${NAMES.agentKnowledgeBase}/mcp?api-version=${NAMES.searchApiVersion}\``],
          ['Header', '`x-ms-query-source-authorization: {{search_auth_token}}`, filled on every run from the required structured input `search_auth_token`, your search token'],
          ['Project connection', `\`${NAMES.connection}\``],
        ],
      },
      {
        title: `Project connection \`${NAMES.connection}\``,
        file: 'infra/modules/foundry.bicep',
        rows: [
          ['Category', '`RemoteTool`'],
          ['Authentication', "`ProjectManagedIdentity`: the Foundry project's managed identity, audience `https://search.azure.com/`"],
          ['Target', "The knowledge base's MCP endpoint"],
        ],
      },
      {
        title: `Knowledge base \`${NAMES.agentKnowledgeBase}\``,
        file: 'search/knowledge-base-agent.json',
        rows: [
          ['Output mode', '`extractiveData`: passages only, no answer synthesis'],
          ['Retrieval reasoning effort', '`minimal`: no query planning model'],
          ['Knowledge source', `\`${NAMES.knowledgeSource}\`, shared with Direct retrieval`],
          ['Maximum runtime', `${RETRIEVE_LIMITS.maxRuntimeInSeconds} s`],
          ['Maximum passages', `${RETRIEVE_LIMITS.maxOutputDocuments} per tool call`],
          ['Maximum output', `${RETRIEVE_LIMITS.maxOutputSizeInTokens.toLocaleString('en-CA')} tokens per tool call`],
        ],
      },
    ],
    prompts: [{ title: 'Agent instructions (system prompt)', file: 'agent/instructions.md', text: AGENT_INSTRUCTIONS }],
    promptNote:
      "These instructions are ours in full and versioned with the agent. The model also sees the tool's description, which Azure AI Search generates from Microsoft's retrieval guidance and the knowledge base description.",
    citations: [
      'Each tool call returns up to 12 documents. Each has the passage text, its source data (title, institution, fiscal year, PDF page range, file, bounding polygons) and its `citationUrl`.',
      'The agent cites passages as `【message_idx:search_idx†source】`. Foundry Agent Service turns each marker into a `url_citation` annotation whose URL is that passage’s `citationUrl`.',
      'The API rewrites each annotated marker as `[ref_id:N]` and runs the same grounding gate as Direct retrieval. Markers Foundry couldn’t annotate, or whose passage wasn’t returned in this run, are removed and reported.',
      "Reranker scores don't pass through MCP, so agent citations have no score.",
      ...documentCitations,
    ],
    conversation: [
      'Stateless: the conversation travels as Responses API input messages, and `store: false` keeps responses and conversations out of Foundry storage. Foundry’s server-side traces, including the question, passages and answer, go to the project’s Application Insights.',
      'Budget: 786,000 tokens, which is the 922,000-token input window minus 128,000 for tool results and 8,000 for instructions. `CONVERSATION_TOKEN_BUDGET` can lower it.',
      'The agent rewrites follow-ups such as "and TD?" into standalone questions before it searches.',
    ],
    identities: [
      ['Web app server', 'Function App', 'Function key, plus your search token', 'Proxies `/api` calls'],
      ['Function App (user-assigned identity)', 'Foundry resource', 'Foundry User', 'Runs the agent through the Responses API'],
      ['Foundry project (system-assigned identity)', 'Azure AI Search', 'Search Index Data Reader', `The tool's knowledge base calls, through \`${NAMES.connection}\``],
      ['Azure AI Search (system-assigned identity)', 'Foundry resource', 'Cognitive Services OpenAI User', 'Query embeddings'],
      ['Operator and pipeline identities', 'Foundry resource', 'Foundry User', 'Create agent versions'],
      ...signInIdentities,
    ],
    observability: [
      '`diagnostics.agent` reports the agent name and version, model deployment, run status and Foundry response ID.',
      '`diagnostics.activity` has one `knowledgeBaseCall` entry per tool call: the query the agent wrote, the passages returned and any error.',
      'Token usage comes from the Responses API. Input tokens include every passage the agent read, about 16,000 per tool call.',
      'Every request logs an `ask_telemetry` trace to Application Insights with `mode` set to `agent`. The agent can also be tried in the Foundry portal playground.',
      'Foundry traces every run server-side into the same Application Insights, through a project connection: an `invoke_agent` span with the conversation and answer, an `execute_tool` span per knowledge base call with its query and passages, and a `chat` span per model call with token usage. Find them under Agents → Traces in the Foundry portal by response ID.',
      'The API response has only the total run time; the Foundry traces time each step.',
    ],
    strengths: [
      'The agent adapts its searching: one call per institution or year, in parallel, and a rephrased call when results fall short.',
      'The prompt is entirely ours, and every change is a new immutable agent version.',
      'Follow-ups are rewritten into standalone questions before searching.',
      'The same agent can serve other Foundry clients, such as the portal playground or Copilot Studio.',
    ],
    limitations: [
      'More input tokens: the model reads every returned passage itself.',
      'No per-stage timings in the API response (the Foundry traces have them) and no reranker scores.',
      'Tool use depends on the instructions; the API warns when the agent answers without searching.',
      'Citations depend on the agent using the marker format; unmatched markers are removed.',
      'Preview features: `RemoteTool` project connections and the knowledge base MCP endpoint (`2026-08-01-preview`).',
      ...documentLimitations,
    ],
  },
};

export const COMPARISON: [aspect: string, direct: string, agent: string][] = [
  ['Who orchestrates', 'The API makes one `retrieve` call; the knowledge base runs fixed steps', 'Foundry Agent Service; the agent decides what to search and how often'],
  ['Query planning', 'Knowledge base planner (GPT-5.6 Sol)', 'The agent (GPT-5.6 Sol), one tool call per information need'],
  ['Knowledge base', `\`${NAMES.knowledgeBase}\`, answer synthesis`, `\`${NAMES.agentKnowledgeBase}\`, extractive data`],
  ['Search', `Hybrid + semantic reranking on \`${NAMES.index}\``, 'The same'],
  ['Answer written by', 'Knowledge base answer synthesis', 'The agent'],
  ['Prompt control', 'Two instruction fields inside a Microsoft-managed prompt', 'Full agent instructions, versioned'],
  ['Citations', '`[ref_id:N]` in the knowledge base’s answer', '`url_citation` annotations from Foundry'],
  ['Citation check', 'Grounding gate', 'The same grounding gate'],
  ['Documents and access', 'SharePoint sites; Azure AI Search filters every search to your groups', "The same; your token reaches the knowledge base through the MCP tool's header"],
  ['Timing detail', 'Per stage', 'Total in the API; per step in the Foundry traces'],
  ['Stored server-side', 'Nothing', 'Nothing in Foundry (`store: false`); run traces in Application Insights'],
];
