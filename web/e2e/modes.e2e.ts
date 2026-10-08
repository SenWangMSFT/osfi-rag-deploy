import { expect, test, type Page } from '@playwright/test';
import type { AnswerMode, AskResponse, Citation } from '../src/types';

const CITATION: Citation = {
  n: 1, ref_id: '1.2', label: 'Royal Bank of Canada Annual Report 2025 — p. 116', doc_title: 'Royal Bank of Canada Annual Report 2025',
  institution: 'RBC', fiscal_year: '2025', page_from: 116, page_to: 116, source_file: 'rbc.pdf', document_id: 'rbc.pdf',
  link: '/api/docs/rbc.pdf#page=116', citation_url: null, doc_key: 'chunk-271', reranker_score: null,
  excerpt: 'The CET1 ratio was 13.5% at October 31, 2025.', bounding_polygons: null,
};

function answer(mode: AnswerMode): AskResponse {
  const base: AskResponse = {
    mode,
    answer: `RBC's CET1 ratio was **13.5%**.[1]`,
    citations: [CITATION],
    warnings: [],
    diagnostics: {
      mode, elapsed_ms: 7200, retrieve_status: 200, gate_passed: true, reference_count: 19, citation_count: 1,
      uncited_reference_count: 18, unresolved_ref_ids: [], incomplete_ref_ids: [], grounded_sentence_ratio: 1,
      sentences_total: 1, sentences_grounded: 1, input_tokens: 33433, output_tokens: 177, reasoning_tokens: 12,
      activity: [
        { type: 'modelQueryPlanning', elapsed_ms: 1800 },
        { type: 'searchIndex', query: 'RBC CET1 2025', count: 42 },
        { type: 'modelAnswerSynthesis', elapsed_ms: 2900 },
      ],
    },
  };
  if (mode === 'direct') return base;
  return {
    ...base,
    diagnostics: {
      ...base.diagnostics,
      activity: [
        { type: 'knowledgeBaseCall', query: 'RBC CET1 ratio end fiscal 2025', count: 12, status: 'completed' },
        { type: 'knowledgeBaseCall', query: 'TD CET1 ratio end fiscal 2025', count: 12, status: 'completed' },
      ],
      agent: {
        name: 'osfi-annual-reports-agent', version: '3', model: 'gpt-5-6-sol', response_id: 'resp_123',
        status: 'completed', tool_calls: 2,
      },
    },
  };
}

async function mockApi(page: Page, asked: { question: string; mode?: string }[]) {
  await page.route('**/api/documents', (route) => route.fulfill({ json: { documents: [] } }));
  await page.route('**/api/ask', async (route) => {
    const body = route.request().postDataJSON();
    asked.push(body);
    await route.fulfill({ json: answer(body.mode === 'agent' ? 'agent' : 'direct') });
  });
}

async function ask(page: Page, question: string) {
  const answers = await page.locator('.answer-prose').count();
  await page.getByRole('textbox', { name: 'Ask a question about the annual reports' }).fill(question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.answer-prose')).toHaveCount(answers + 1);
}

test('sends the selected mode, labels each answer with its mode, and remembers the choice', async ({ page }) => {
  const asked: { question: string; mode?: string }[] = [];
  await mockApi(page, asked);
  await page.goto('/');
  const direct = page.getByRole('radio', { name: 'Direct retrieval' });
  const agent = page.getByRole('radio', { name: 'Foundry Agent' });
  await expect(direct).toBeChecked();

  await ask(page, 'What was RBC CET1?');
  await agent.check();
  await ask(page, 'And TD?');
  expect(asked.map((request) => request.mode)).toEqual(['direct', 'agent']);

  const turns = page.getByRole('article');
  await expect(turns.nth(0).getByRole('link', { name: 'Direct retrieval' })).toBeVisible();
  await expect(turns.nth(1).getByRole('link', { name: 'Foundry Agent' })).toBeVisible();
  await expect(turns.nth(1).getByRole('link', { name: 'Foundry Agent' })).toHaveAttribute('href', '/how-it-works/agent');

  await page.reload();
  await expect(page.getByRole('radio', { name: 'Foundry Agent' })).toBeChecked();
  await expect(page.getByRole('article').nth(0).getByRole('link', { name: 'Direct retrieval' })).toBeVisible();
  await page.getByRole('radio', { name: 'Foundry Agent' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: 'Direct retrieval' })).toBeChecked();
});

test('shows the agent run, its knowledge base calls, and token usage', async ({ page }) => {
  await mockApi(page, []);
  await page.goto('/');
  await page.getByRole('radio', { name: 'Foundry Agent' }).check();
  await ask(page, 'Compare RBC and TD CET1.');
  await expect(page.getByRole('button', { name: /^Source 1:/ })).toBeVisible();
  await page.getByRole('button', { name: 'How this answer was found' }).click();
  const details = page.getByRole('region', { name: 'Retrieval details' });
  await expect(details.getByText('Agent-reported activity', { exact: true })).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Agent run' })).toBeVisible();
  await expect(details).toContainText('osfi-annual-reports-agent · version 3');
  const calls = details.getByRole('list', { name: 'Knowledge base calls' });
  await expect(calls.getByRole('listitem')).toHaveCount(2);
  await expect(calls).toContainText('TD CET1 ratio end fiscal 2025');
  await expect(calls).toContainText('12 passages returned');
  await expect(details.getByText('Total service time', { exact: true }).locator('..')).toContainText('7.2 s');
  await expect(details.getByText('Remaining service time', { exact: true })).toHaveCount(0);
  await details.getByRole('button', { name: 'Technical details' }).click();
  await expect(details.getByText('Response ID', { exact: true }).locator('..').locator('dd')).toHaveText('resp_123');
  await expect(details.getByText('Input tokens', { exact: true }).locator('..').locator('dd')).toHaveText('33,433');
});

test('warns when the agent answered without searching or an older API ignored the mode', async ({ page }) => {
  await page.route('**/api/documents', (route) => route.fulfill({ json: { documents: [] } }));
  let call = 0;
  await page.route('**/api/ask', (route) => {
    call += 1;
    const legacy = { ...answer('direct'), mode: undefined, diagnostics: { ...answer('direct').diagnostics, mode: undefined } };
    const unsearched: AskResponse = {
      ...answer('agent'), answer: 'From memory.', citations: [],
      warnings: ['The agent answered without searching the reports.'],
      diagnostics: { ...answer('agent').diagnostics, activity: [], citation_count: 0, gate_passed: true },
    };
    return route.fulfill({ json: call === 1 ? legacy : unsearched });
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Foundry Agent' }).check();
  await ask(page, 'Question one?');
  await expect(page.getByText('does not support Foundry Agent mode yet', { exact: false })).toBeVisible();
  await expect(page.getByRole('article').nth(0).getByRole('link', { name: 'Direct retrieval' })).toBeVisible();

  await ask(page, 'Question two?');
  await expect(page.getByText('The agent answered without searching the reports.')).toBeVisible();
  await page.getByRole('button', { name: 'How this answer was found' }).last().click();
  await expect(page.getByRole('region', { name: 'Retrieval details' }).last())
    .toContainText("The agent didn't call the knowledge base");
});

test('explains agent failures and retries in the same mode', async ({ page }) => {
  await page.route('**/api/documents', (route) => route.fulfill({ json: { documents: [] } }));
  const modes: string[] = [];
  await page.route('**/api/ask', (route) => {
    modes.push(route.request().postDataJSON().mode);
    return modes.length === 1
      ? route.fulfill({ status: 502, json: { error: 'The Foundry agent run failed.', status: 500 } })
      : route.fulfill({ json: answer('agent') });
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Foundry Agent' }).check();
  await page.getByRole('textbox').fill('Question?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The Foundry agent is not responding');
  await page.getByRole('radio', { name: 'Direct retrieval' }).check();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.answer-prose')).toBeVisible();
  expect(modes).toEqual(['agent', 'agent']);
});

test('opens each technical specification, switches between them, and returns to the conversation', async ({ page }) => {
  await mockApi(page, []);
  await page.goto('/');
  await ask(page, 'What was RBC CET1?');
  await page.getByRole('radio', { name: 'Foundry Agent' }).check();
  await page.getByRole('link', { name: 'How Foundry Agent works' }).click();

  await expect(page).toHaveURL(/\/how-it-works\/agent$/);
  await expect(page).toHaveTitle('Foundry Agent: how it works | OSFI');
  const title = page.getByRole('heading', { name: 'Foundry Agent', level: 2 });
  await expect(title).toBeFocused();
  for (const section of ['At a glance', 'Architecture', 'Request lifecycle', 'Configuration', 'Documents from SharePoint',
    'Scaling to 100 institution sites', 'Prompts', 'Citations and verification', 'Who sees what', 'Identity and access',
    'Deployment setup', 'Compare the modes']) {
    await expect(page.getByRole('heading', { name: section, level: 3 })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'The sync publishes them with permissions', level: 4 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'https://contoso.sharepoint.com/sites/td' }))
    .toHaveAttribute('target', '_blank');
  await expect(page.getByRole('list', { name: 'Request path' }).getByRole('listitem').first()).toContainText('Browser');
  await expect(page.locator('pre').first()).toContainText('Use the knowledge_base_retrieve tool for every question');
  await expect(page.getByText('Selected for your next question')).toBeVisible();

  const modes = page.getByRole('navigation', { name: 'Answer modes' });
  await expect(modes.getByRole('link', { name: 'Foundry Agent' })).toHaveAttribute('aria-current', 'page');
  await modes.getByRole('link', { name: 'Direct retrieval' }).click();
  await expect(page).toHaveURL(/\/how-it-works\/direct$/);
  await expect(page.getByRole('heading', { name: 'Direct retrieval', level: 2 })).toBeFocused();
  await expect(page.locator('pre').first()).toContainText('All content is annual reports');

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Foundry Agent', level: 2 })).toBeVisible();
  await modes.getByRole('link', { name: 'Direct retrieval' }).click();
  await page.getByRole('button', { name: 'Use Direct retrieval for my next question' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle('Annual report research | OSFI');
  await expect(page.getByRole('radio', { name: 'Direct retrieval' })).toBeChecked();
  await expect(page.getByRole('article')).toHaveCount(1);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 960 }]) {
  test(`deep links to a specification page and fits it on a ${viewport.width}px screen`, async ({ page }) => {
    await mockApi(page, []);
    await page.setViewportSize(viewport);
    await page.goto('/how-it-works/direct');
    await expect(page.getByRole('heading', { name: 'Direct retrieval', level: 2 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'On this page' })).toBeVisible({ visible: viewport.width >= 1024 });
    const fits = await page.evaluate(() => {
      const spec = document.querySelector('.spec-page')!;
      return document.documentElement.scrollWidth <= innerWidth + 1 && spec.scrollWidth <= spec.clientWidth + 1;
    });
    expect(fits).toBe(true);
    await page.getByRole('link', { name: /^Back/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Start with a question.' })).toBeVisible();
    await page.getByRole('link', { name: 'Foundry Agent', exact: true }).click();
    await expect(page).toHaveURL(/\/how-it-works\/agent$/);
  });
}
