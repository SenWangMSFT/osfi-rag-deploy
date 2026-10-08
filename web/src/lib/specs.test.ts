import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_INSTRUCTIONS, DIRECT_PROMPTS, NAMES, RETRIEVE_LIMITS, SYNC } from './specs';

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const json = (path: string) => JSON.parse(repo(path));

// The specification pages quote configuration that lives outside web/. Update web/src/lib/specs.ts with it.
describe('technical specifications match the deployed configuration', () => {
  it('quotes the direct knowledge base instructions and limits', () => {
    const kb = json('search/knowledge-base.json');
    expect(DIRECT_PROMPTS.retrieval).toBe(kb.retrievalInstructions);
    expect(DIRECT_PROMPTS.answer).toBe(kb.answerInstructions);
    expect(kb.outputMode).toBe('answerSynthesis');
    expect(kb.retrievalReasoningEffort.kind).toBe('low');
    expect(kb.retrieveDefaults).toEqual(RETRIEVE_LIMITS);
  });

  it('describes the agent knowledge base', () => {
    const kb = json('search/knowledge-base-agent.json');
    expect(kb.outputMode).toBe('extractiveData');
    expect(kb.retrievalReasoningEffort.kind).toBe('minimal');
    expect(kb.retrieveDefaults).toEqual(RETRIEVE_LIMITS);
  });

  it('quotes the agent instructions and tool configuration', () => {
    expect(AGENT_INSTRUCTIONS).toBe(repo('agent/instructions.md').replace(/\r\n/g, '\n').trim());
    const { definition } = json('agent/agent.json');
    expect(definition.kind).toBe('prompt');
    expect(definition.reasoning.effort).toBe('low');
    expect(definition.tools).toHaveLength(1);
    expect(definition.tools[0]).toMatchObject({
      type: 'mcp',
      server_label: NAMES.serverLabel,
      require_approval: 'never',
      allowed_tools: { tool_names: [NAMES.tool] },
    });
  });

  it('uses the object names deployed by infra/main.bicep', () => {
    const bicep = repo('infra/main.bicep');
    for (const fragment of [
      `index: '${NAMES.index}'`,
      `stagingIndex: '${NAMES.stagingIndex}'`,
      `indexer: '${NAMES.indexer}'`,
      `knowledgeSource: '${NAMES.knowledgeSource}'`,
      `knowledgeBase: '${NAMES.knowledgeBase}'`,
      `agentKnowledgeBase: '${NAMES.agentKnowledgeBase}'`,
      `name: '${NAMES.agent}'`,
      `connection: '${NAMES.connection}'`,
      `apiVersion: '${NAMES.searchApiVersion}'`,
    ]) {
      expect(bicep).toContain(fragment);
    }
    expect(repo('infra/main.bicepparam')).toContain(`name: '${NAMES.chatDeployment}'`);
  });

  it('describes the SharePoint sync and permission filtering as configured', () => {
    expect(repo('src/function_app/function_app.py')).toContain(`schedule="${SYNC.schedule}"`);
    const config = repo('src/function_app/rag/config.py');
    expect(config).toContain(`sync_max_files_per_run: int = ${SYNC.filesPerRun}`);
    expect(config).toContain(`sync_max_file_bytes: int = ${SYNC.maxFileMegabytes} * 1024 * 1024`);
    expect(repo('scripts/setup_web_auth.py')).toContain(`DISPLAY_NAME = "${NAMES.webApp}"`);
    expect(json('search/index.json').permissionFilterOption).toBe('enabled');
    expect(json('search/staging-index.json').permissionFilterOption).toBeUndefined();
    expect(json('search/indexer.json').targetIndexName).toBe('${SEARCH_STAGING_INDEX}');
    expect(json('agent/agent.json').definition.tools[0].headers).toEqual({
      'x-ms-query-source-authorization': '{{search_auth_token}}',
    });
  });

  it('describes the setup the scaling and deployment sections refer to', () => {
    expect(repo('infra/main.bicepparam')).toContain("param searchSku = 'standard'");
    // The registry's sites differ per deployment (the pages show examples), so only its columns are checked. A
    // spreadsheet may save it with a byte order mark.
    expect(repo('config/institutions.csv').split(/\r?\n/)[0].replace(/^\uFEFF/, '')).toBe(
      'institution_key,institution_name,site_url,site_id,group_ids,libraries,language',
    );
    const grants = repo('scripts/grant_sharepoint_access.ps1');
    for (const fragment of ['Sites.Selected', "scope = 'user_impersonation'", 'grantedToIdentities']) {
      expect(grants).toContain(fragment);
    }
  });
});
