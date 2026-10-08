import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AskResponse, Citation, HistoryMessage, LibraryDocument } from '../src/types';

const QUESTION = 'Compare the CET1 ratios of RBC and TD at the end of fiscal 2025.';
const DOCUMENTS: LibraryDocument[] = [
  { file: 'rbc.pdf', title: 'Royal Bank of Canada Annual Report 2025', institution: 'RBC', fiscal_year: '2025',
    size_bytes: 2_400_000, last_modified: null, chunks: 500 },
  { file: 'td.pdf', title: 'TD Bank Group 2025 Annual Report', institution: 'TD', fiscal_year: '2025',
    size_bytes: 3_000_000, last_modified: null, chunks: 600 },
  { file: 'pending.pdf', title: 'Report awaiting indexing', institution: null, fiscal_year: '2025',
    size_bytes: 1_000, last_modified: null, chunks: 0 },
];
const CITATIONS: Citation[] = DOCUMENTS.slice(0, 2).map((document, index) => ({
  n: index + 1, ref_id: `ref-${index}`, label: document.title, doc_title: document.title,
  institution: document.institution, fiscal_year: document.fiscal_year,
  page_from: index === 0 ? 238 : 76, page_to: index === 0 ? 238 : 76,
  source_file: document.file, document_id: document.file, link: `/api/docs/${document.file}`, citation_url: null,
  doc_key: `chunk-${index}`, reranker_score: 3.5, bounding_polygons: null,
  excerpt: `<table><tr><th>Capital ratio</th><th>2025</th></tr><tr><td>CET1</td><td>${index === 0 ? '13.5%' : '14.7%'}</td></tr></table>`,
}));
const RESPONSE: AskResponse = {
  answer: 'At fiscal year-end **October 31, 2025**:\n\n- **RBC:** CET1 ratio of **13.5%**.[1]\n- **TD:** CET1 ratio of **14.7%**.[2]\n\nTD was **1.2 percentage points** higher.[1][2]',
  citations: CITATIONS,
  warnings: [],
  diagnostics: {
    elapsed_ms: 6400, retrieve_status: 200, gate_passed: true, reference_count: 12, citation_count: 2,
    uncited_reference_count: 10, unresolved_ref_ids: [], incomplete_ref_ids: [],
    grounded_sentence_ratio: 1, sentences_total: 3, sentences_grounded: 3,
    input_tokens: 1000, output_tokens: 150, reasoning_tokens: 500,
    activity: [
      { type: 'modelQueryPlanning', elapsed_ms: 1800 },
      { type: 'searchIndex', query: 'RBC TD CET1 ratios 2025', count: 42 },
      { type: 'modelAnswerSynthesis', elapsed_ms: 2900 },
    ],
  },
};

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  // All service calls are deterministic and local; this suite never calls Azure.
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/documents') await route.fulfill({ json: { documents: DOCUMENTS } });
    else if (url.pathname === '/api/ask') await route.fulfill({ json: RESPONSE });
    else if (url.pathname.startsWith('/api/docs/')) {
      await route.fulfill({ json: { url: `${url.origin}/test-document` } });
    } else throw new Error(`Unexpected API request: ${url.pathname}`);
  });
  await page.route('**/test-document', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html lang="en"><title>Annual report fixture</title><body><h1>Annual report fixture</h1><p>Local source viewer test.</p></body></html>',
  }));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function ask(page: Page, question = QUESTION) {
  const previousAnswers = await page.locator('.answer-prose').count();
  await page.getByRole('textbox', { name: 'Ask a question about the annual reports' }).fill(question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.answer-prose')).toHaveCount(previousAnswers + 1);
  await expect(page.locator('.answer-prose').last()).toBeVisible();
}

async function bounds(locator: Locator) {
  const rectangle = await locator.boundingBox();
  if (!rectangle) throw new Error(`No bounding box for ${locator}`);
  return rectangle;
}

async function expectPanelInsets(page: Page, panel: Locator, width = 44) {
  const workspace = await bounds(page.locator('.workspace'));
  const pane = await bounds(panel);
  const footer = await bounds(page.locator('.app-footer'));
  expect(pane.width).toBeCloseTo(workspace.width * width / 100, 0);
  expect(pane.height).toBeCloseTo(workspace.height - 40, 0);
  expect(pane.y - workspace.y).toBeCloseTo(20, 0);
  expect(footer.y - pane.y - pane.height).toBeCloseTo(20, 0);
}

async function expectFooterLayout(page: Page) {
  const footer = page.getByRole('contentinfo');
  await expect(footer).not.toContainText('Research preview. Not official OSFI guidance.');
  await expect(footer.getByText('Powered by', { exact: true })).toBeVisible();
  const credit = footer.locator('.technology-credit');
  await expect(credit).toHaveCSS('justify-content', 'flex-start');
  const rectangle = await bounds(footer);
  const padding = await footer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) };
  });
  const credits = await bounds(credit);
  const responsible = await bounds(footer.getByRole('button', { name: 'Responsible AI', exact: true }));
  expect(credits.x).toBeCloseTo(rectangle.x + padding.left, 0);
  expect(responsible.x + responsible.width).toBeCloseTo(rectangle.x + rectangle.width - padding.right, 0);
  const sharesRow = responsible.y < credits.y + credits.height && credits.y < responsible.y + responsible.height;
  if (sharesRow) expect(responsible.x).toBeGreaterThanOrEqual(credits.x + credits.width + 15);
  else expect(responsible.y).toBeGreaterThanOrEqual(credits.y + credits.height + 7);
}

async function noOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);
  expect(await page.locator('.conversation-scroll').evaluate((element) =>
    element.scrollWidth <= element.clientWidth + 1,
  )).toBe(true);
}

test('presents OSFI branding, restrained technology credits, and a clear preview disclaimer', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Annual report research | OSFI');
  await expect(page.getByRole('heading', { name: 'Start with a question.' })).toBeVisible();
  await expect(page.getByText('AI-generated answers may be wrong.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Microsoft Foundry', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Foundry IQ', exact: true })).toBeVisible();
  await expect(page.getByRole('banner').getByText('Research preview', { exact: true })).toBeVisible();
  await expectFooterLayout(page);
  await expect(page.getByRole('button', { name: 'Library, 2 reports' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Available reports' })).toHaveCount(0);
  await expect(page.getByText('In your library', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Royal Bank of Canada Annual Report 2025' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  const logo = page.getByRole('img', { name: 'OSFI / BSIF' });
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.getByRole('region', { name: 'Suggested questions' }).getByRole('button').first().click();
  await expect(page.locator('.answer-prose')).toBeVisible();
  await noOverflow(page);
});

test('right-aligns questions, carries follow-up history, restores chat, and starts a new conversation', async ({ page }) => {
  const requests: { question: string; history: HistoryMessage[] }[] = [];
  await page.route('**/api/ask', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: RESPONSE });
  });
  await page.goto('/');
  await ask(page);
  const user = await bounds(page.locator('.user-message'));
  const assistant = await bounds(page.locator('.assistant-message'));
  expect(user.x).toBeGreaterThan(assistant.x + 30);
  expect(Math.abs(user.x + user.width - assistant.x - assistant.width)).toBeLessThan(2);
  await ask(page, 'Which institution had the higher ratio?');
  expect(requests[1]?.history).toEqual([
    { role: 'user', text: QUESTION },
    { role: 'assistant', text: expect.stringContaining('13.5%') },
  ]);
  expect(requests[1]?.history[1]?.text).not.toContain('[1]');
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(2);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toBeFocused();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Start with a question.' })).toBeVisible();
});

test('opens exact PDF pages, navigates citations and accessible tabs, and restores focus on Escape', async ({ page }) => {
  await page.goto('/');
  await ask(page);
  const chip = page.getByRole('button', { name: 'Source 1:', exact: false }).first();
  await chip.click();
  const panel = page.getByRole('dialog', { name: 'Source viewer' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('iframe')).toHaveAttribute('src', /#page=238&/);
  await expectPanelInsets(page, panel);
  await expect(panel.getByRole('link', { name: 'Open the PDF in a new tab' })).toHaveAttribute('href', '/api/docs/rbc.pdf#page=238');
  await panel.getByRole('tab', { name: 'Page', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'Passage' })).toBeFocused();
  await expect(panel.getByRole('tabpanel', { name: 'Passage' }).locator('mark')).toContainText('13.5');
  await panel.getByRole('button', { name: 'Next source' }).click();
  await expect(panel.getByRole('tabpanel', { name: 'Passage' }).locator('mark')).toContainText('14.7');
  await expect(panel.getByRole('button', { name: 'Next source' })).toBeDisabled();
  await panel.getByRole('tab', { name: 'Page', exact: true }).click();
  await expect(panel.locator('iframe')).toHaveAttribute('src', /#page=76&/);
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(chip).toBeFocused();
});

test('discloses source cards on demand while inline previews and keyboard citations remain usable', async ({ page }) => {
  await page.goto('/');
  await ask(page);
  const sources = page.getByRole('region', { name: 'Sources', exact: true });
  const disclosure = sources.getByRole('button', { name: 'Sources (2)', exact: true });
  const cards = sources.getByRole('list', { name: 'Source cards' });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(cards).not.toBeVisible();
  const controlledId = await disclosure.getAttribute('aria-controls');
  expect(controlledId).toBeTruthy();
  await expect(page.locator(`[id="${controlledId}"]`)).toBeHidden();

  const chip = page.getByRole('button', { name: 'Source 1:', exact: false }).first();
  await chip.hover();
  await expect(page.getByRole('tooltip')).toContainText('Click to open p. 238');
  await chip.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Source viewer' });
  await expect(panel.locator('iframe')).toHaveAttribute('src', /#page=238&/);
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(cards.getByRole('button')).toHaveCount(2);
  const firstCard = cards.getByRole('button', { name: /Royal Bank of Canada Annual Report/ });
  await firstCard.focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('iframe')).toHaveAttribute('src', /#page=238&/);
  await expect(firstCard).toHaveAttribute('aria-pressed', 'true');
  await panel.locator('iframe').evaluate((frame) => frame.setAttribute('data-preserved', 'yes'));
  await disclosure.click();
  await expect(cards).not.toBeVisible();
  await expect(panel.locator('iframe')).toHaveAttribute('data-preserved', 'yes');
  await panel.getByRole('button', { name: 'Close source panel (Esc)' }).click();
  await expect(page.getByRole('textbox')).toBeFocused();

  await disclosure.click();
  const secondCard = cards.getByRole('button', { name: /TD Bank Group 2025 Annual Report/ });
  await secondCard.click();
  await expect(panel.locator('iframe')).toHaveAttribute('src', /#page=76&/);
  await page.keyboard.press('Escape');
  await expect(secondCard).toBeFocused();
  await disclosure.focus();
  await page.keyboard.press('Space');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(cards).not.toBeVisible();
});

test('keeps each answer source disclosure independent and collapsed for new answers', async ({ page }) => {
  await page.goto('/');
  await ask(page);
  const first = page.getByRole('region', { name: 'Sources', exact: true }).first()
    .getByRole('button', { name: 'Sources (2)', exact: true });
  await first.click();
  await ask(page, 'Which ratio was higher?');
  const second = page.getByRole('region', { name: 'Sources', exact: true }).last()
    .getByRole('button', { name: 'Sources (2)', exact: true });
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(second).toHaveAttribute('aria-expanded', 'false');
  expect(await first.getAttribute('aria-controls')).not.toBe(await second.getAttribute('aria-controls'));
  await second.click();
  await first.click();
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(second).toHaveAttribute('aria-expanded', 'true');
});

test('collapses without losing the source, tab, PDF, or draft question', async ({ page }) => {
  await page.goto('/');
  await ask(page);
  await page.getByRole('textbox').fill('A draft follow-up');
  await page.getByRole('button', { name: 'Source 1:', exact: false }).first().click();
  const panel = page.getByRole('dialog', { name: 'Source viewer' });
  await expect(panel.locator('iframe')).toHaveAttribute('src', /#page=238&/);
  await panel.locator('iframe').evaluate((frame) => frame.setAttribute('data-preserved', 'yes'));
  await panel.getByRole('tab', { name: 'Passage' }).click();
  await expect(panel.locator('.passage')).toBeVisible();
  const before = await bounds(page.getByRole('main'));
  await panel.getByRole('button', { name: 'Collapse source panel' }).click();
  await expect(panel).not.toBeVisible();
  expect((await bounds(page.getByRole('main'))).width).toBeGreaterThan(before.width + 300);
  await page.getByRole('button', { name: 'Show source panel' }).click();
  await expect(panel).toBeFocused();
  await expect(panel.getByRole('tab', { name: 'Passage' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('iframe')).toHaveAttribute('data-preserved', 'yes');
  await expect(page.getByRole('textbox')).toHaveValue('A draft follow-up');
  await expectPanelInsets(page, panel);
});

test('resizes both edges with the pointer and keyboard, expands, and restores its previous dimensions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Library, 2 reports' }).click();
  const panel = page.getByRole('dialog', { name: 'Source viewer' });
  await expectPanelInsets(page, panel);
  const initial = await bounds(panel);
  const width = panel.getByRole('separator', { name: 'Resize source panel width' });
  let handle = await bounds(width);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 80, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  expect((await bounds(panel)).width).toBeCloseTo(initial.width + 80, 0);
  const height = panel.getByRole('separator', { name: 'Resize source panel height' });
  handle = await bounds(height);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 60, { steps: 8 });
  await page.mouse.up();
  expect((await bounds(panel)).height).toBeCloseTo(initial.height - 60, 0);
  await width.focus();
  await page.keyboard.press('Home');
  await expect(width).toHaveAttribute('aria-valuenow', '32');
  await page.keyboard.press('End');
  await expect(width).toHaveAttribute('aria-valuenow', '64');
  await page.keyboard.press('ArrowRight');
  await expect(width).toHaveAttribute('aria-valuenow', '62');
  await height.focus();
  await page.keyboard.press('Home');
  await expect(height).toHaveAttribute('aria-valuenow', '45');
  await page.keyboard.press('End');
  await expect(height).toHaveAttribute('aria-valuenow', '100');
  await expect(height).toHaveAttribute('aria-valuetext', '100% of available height');
  expect((await bounds(panel)).height).toBeCloseTo(initial.height, 0);
  await page.keyboard.press('ArrowUp');
  await expect(height).toHaveAttribute('aria-valuenow', '98');
  expect((await bounds(panel)).height).toBeCloseTo(initial.height * 0.98, 0);
  const resized = await bounds(panel);
  await panel.getByRole('button', { name: 'Expand source panel', exact: true }).click();
  await expect(panel.getByRole('separator')).toHaveCount(0);
  expect((await bounds(panel)).width).toBeGreaterThan(resized.width);
  await expectPanelInsets(page, panel, 64);
  await panel.getByRole('button', { name: 'Restore source panel size' }).click();
  expect((await bounds(panel)).width).toBeCloseTo(resized.width, 0);
  expect((await bounds(panel)).height).toBeCloseTo(resized.height, 0);
  await noOverflow(page);
});

test('keeps the default panel inset as the desktop workspace height changes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Library, 2 reports' }).click();
  const panel = page.getByRole('dialog', { name: 'Source viewer' });
  await expectPanelInsets(page, panel);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expectPanelInsets(page, panel);
  await panel.getByRole('button', { name: 'Expand source panel', exact: true }).click();
  await expectPanelInsets(page, panel, 64);
  await panel.getByRole('button', { name: 'Restore source panel size' }).click();
  await expectPanelInsets(page, panel);
  await noOverflow(page);
});

test('opens library reports and returns to the library', async ({ page }) => {
  await page.goto('/');
  const library = page.getByRole('button', { name: 'Library, 2 reports' });
  await library.click();
  const panel = page.getByRole('dialog', { name: 'Source viewer' });
  await expect(panel.getByText('Not indexed', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: /Royal Bank of Canada Annual Report/ }).click();
  await expect(panel.locator('iframe')).toHaveAttribute('src', /#page=1&/);
  await panel.getByRole('button', { name: 'Back to the library' }).click();
  await expect(panel.getByText('2 of 3 reports indexed', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(library).toBeFocused();
});

test('shows a service error and retries the same question', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/ask', (route) => ++attempts === 1
    ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    : route.fulfill({ json: RESPONSE }));
  await page.goto('/');
  await page.getByRole('textbox').fill(QUESTION);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('not responding');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.answer-prose')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(1);
  expect(attempts).toBe(2);
});

test('stops a pending request and can retry without duplicating the question', async ({ page }) => {
  let release = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/ask', async (route) => {
    if (++attempts === 1) await wait;
    await route.fulfill({ json: RESPONSE });
  });
  await page.goto('/');
  await page.getByRole('textbox').fill(QUESTION);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Reviewing');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Stopped before the answer arrived.')).toBeVisible();
  release();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.answer-prose')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(1);
});

test('explains ungrounded and partial answers without claiming verification', async ({ page }) => {
  await page.route('**/api/ask', (route) => route.fulfill({ json: {
    ...RESPONSE, answer: 'The reports do not provide this information.', citations: [],
    diagnostics: { ...RESPONSE.diagnostics, retrieve_status: 206, gate_passed: false, citation_count: 0 },
  } satisfies AskResponse }));
  await page.goto('/');
  await ask(page);
  await expect(page.getByText('Part of the search failed', { exact: false })).toBeVisible();
  await expect(page.getByText("No sources cited, so this reply isn't backed by the reports.")).toBeVisible();
  await expect(page.getByText('sources linked', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'How this answer was found' }).click();
  const details = page.getByRole('region', { name: 'Retrieval details' });
  await expect(details.getByText('Partial retrieval', { exact: true })).toBeVisible();
  await expect(details.getByText('Source matching did not pass.', { exact: true })).toBeVisible();
  await expect(details.getByText('It does not verify the accuracy of the answer.', { exact: false })).toBeVisible();
});

test('copies the answer and sources, and keeps retrieval details available', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await ask(page);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('13.5%');
  expect(copied).toContain('Royal Bank of Canada Annual Report 2025');
  await page.getByRole('button', { name: 'How this answer was found' }).click();
  await expect(page.getByRole('heading', { name: 'Evidence process' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Report search' })).toBeVisible();
  await expect(page.getByText('RBC TD CET1 ratios 2025', { exact: true })).toBeVisible();
});

test('summarizes all measured stages and keeps technical metrics behind a keyboard disclosure', async ({ page }) => {
  await page.route('**/api/ask', (route) => route.fulfill({ json: {
    ...RESPONSE,
    diagnostics: {
      ...RESPONSE.diagnostics, elapsed_ms: 8000, input_tokens: 3210, output_tokens: 456, reasoning_tokens: 123,
      conversation: {
        history_messages_received: 10, history_messages_used: 8, history_messages_omitted: 2,
        estimated_input_tokens: 4200, token_budget: 12000,
      },
      activity: [
        { type: 'modelQueryPlanning', elapsed_ms: 1000 },
        { type: 'searchIndex', query: 'RBC CET1 2025', count: 18, elapsed_ms: 42 },
        { type: 'modelQueryPlanning', elapsed_ms: 500 },
        { type: 'searchIndex', query: 'TD CET1 2025', count: 0, elapsed_ms: 400 },
        { type: 'modelAnswerSynthesis', elapsed_ms: 2000 },
        { type: 'modelAnswerSynthesis', elapsed_ms: 1000 },
      ],
    },
  } satisfies AskResponse }));
  await page.goto('/');
  await ask(page);
  const trigger = page.getByRole('button', { name: 'How this answer was found' });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const details = page.getByRole('region', { name: 'Retrieval details' });
  const planning = details.locator('.diagnostic-step').filter({ has: page.getByRole('heading', { name: 'Query planning', exact: true }) });
  const writing = details.locator('.diagnostic-step').filter({ has: page.getByRole('heading', { name: 'Answer writing', exact: true }) });
  await expect(planning).toContainText('1.5 s measured');
  await expect(planning).toContainText('2 planning stages reported.');
  await expect(writing).toContainText('3.0 s measured');
  await expect(writing).toContainText('2 writing stages reported.');
  const queries = details.getByRole('list', { name: 'Reported search queries' });
  await expect(queries.getByRole('listitem')).toHaveCount(2);
  await expect(queries).toContainText('18 matches returned');
  await expect(queries).toContainText('42 ms measured');
  await expect(queries).toContainText('400 ms measured');
  await expect(queries).toContainText('0 matches returned');
  await expect(details.getByText('Total service time', { exact: true }).locator('..')).toContainText('8.0 s');
  await expect(details.getByText('Remaining service time', { exact: true }).locator('..')).toContainText('3.5 s');
  await expect(details).toContainText('not a measured search duration');
  await expect(details.getByText('Search & ranking', { exact: true })).toHaveCount(0);

  const technical = details.getByRole('button', { name: 'Technical details', exact: true });
  await expect(technical).toHaveAttribute('aria-expanded', 'false');
  await expect(details.getByText('Input tokens', { exact: true })).not.toBeVisible();
  await expect(details.getByRole('region', { name: 'Conversation context' })).not.toBeVisible();
  const technicalId = await technical.getAttribute('aria-controls');
  expect(technicalId).toBeTruthy();
  await expect(page.locator(`[id="${technicalId}"]`)).toBeHidden();
  await technical.focus();
  await page.keyboard.press('Enter');
  await expect(technical).toHaveAttribute('aria-expanded', 'true');
  await expect(details.getByText('3,210', { exact: true })).toBeVisible();
  await expect(details.getByText('456', { exact: true })).toBeVisible();
  await expect(details.getByText('123', { exact: true })).toBeVisible();
  await expect(details.getByText('3 of 3', { exact: true })).toBeVisible();
  await expect(details).toContainText('not a factual accuracy score');
  const conversation = details.getByRole('region', { name: 'Conversation context' });
  await expect(conversation).toBeVisible();
  for (const [label, value] of [
    ['History messages received', '10'], ['History messages used', '8'], ['History messages omitted', '2'],
    ['Estimated input tokens', '4,200'], ['Conversation token budget', '12,000'],
  ]) {
    await expect(conversation.getByText(label, { exact: true }).locator('..').locator('dd')).toHaveText(value);
  }
  await expect(conversation).toContainText('estimates, not measured model usage');
  await page.keyboard.press('Space');
  await expect(technical).toHaveAttribute('aria-expanded', 'false');
  await expect(details.getByText('Input tokens', { exact: true })).not.toBeVisible();
  await trigger.focus();
  await page.keyboard.press('Space');
  await expect(details).not.toBeVisible();
});

for (const conversation of [undefined, null]) {
  test(`omits conversation metrics for saved answers with ${conversation === null ? 'null' : 'missing'} metadata`, async ({ page }) => {
    await page.route('**/api/ask', (route) => route.fulfill({ json: {
      ...RESPONSE, diagnostics: { ...RESPONSE.diagnostics, conversation },
    } satisfies AskResponse }));
    await page.goto('/');
    await ask(page);
    await page.reload();
    await page.getByRole('button', { name: 'How this answer was found' }).click();
    const details = page.getByRole('region', { name: 'Retrieval details' });
    await details.getByRole('button', { name: 'Technical details' }).click();
    await expect(details.getByText('Input tokens', { exact: true })).toBeVisible();
    await expect(details.getByRole('heading', { name: 'Conversation context' })).toHaveCount(0);
    await expect(details.getByText('Estimated input tokens', { exact: true })).toHaveCount(0);
  });
}

const activityCases: { name: string; activity: AskResponse['diagnostics']['activity'] }[] = [
  { name: 'omitted', activity: undefined },
  { name: 'empty', activity: [] },
  { name: 'partial', activity: [
    { type: 'modelQueryPlanning', elapsed_ms: 1000 },
    { type: 'modelQueryPlanning', elapsed_ms: null },
    { type: 'searchIndex', query: null, count: null },
    { type: 'modelAnswerSynthesis', elapsed_ms: null },
  ] },
];

for (const fixture of activityCases) {
  test(`explains ${fixture.name} activity without inventing search or writing time`, async ({ page }) => {
    await page.route('**/api/ask', (route) => route.fulfill({ json: {
      ...RESPONSE, answer: 'No supported figure was returned.', citations: [],
      diagnostics: {
        ...RESPONSE.diagnostics, reference_count: 0, citation_count: 0, gate_passed: false,
        activity: fixture.activity,
      },
    } satisfies AskResponse }));
    await page.goto('/');
    await ask(page);
    await page.getByRole('button', { name: 'How this answer was found' }).click();
    const details = page.getByRole('region', { name: 'Retrieval details' });
    await expect(details.getByText('No passages were retrieved.', { exact: true })).toBeVisible();
    await expect(details.getByText('Timing not reported', { exact: true }).first()).toBeVisible();
    await expect(details.getByText('Remaining service time', { exact: true }).locator('..')).toContainText('Not attributable');
    await expect(details.getByText('Total service time', { exact: true }).locator('..')).toContainText('6.4 s');
    await expect(details).not.toContainText(/NaN|Infinity|Search & ranking/);
    if (fixture.name === 'partial') {
      await expect(details.getByText('1.0 s measured (partial)', { exact: true })).toBeVisible();
      await expect(details).toContainText('1 of 2 durations available.');
      await expect(details.getByText('Query text not reported.', { exact: true })).toBeVisible();
      await expect(details.getByText('Match count not reported', { exact: true })).toBeVisible();
    } else {
      await expect(details).toContainText('No stage activity was reported.');
      await expect(details).toContainText('No search queries were reported; this does not mean no search ran.');
    }
  });
}

for (const fixture of [
  { name: 'zero durations', total: 0, planning: 0, writing: 0, remaining: '0 ms' },
  { name: 'overlapping stage durations', total: 1000, planning: 1500, writing: 500, remaining: 'Not attributable' },
]) {
  test(`handles ${fixture.name} without substituting a fictional search duration`, async ({ page }) => {
    await page.route('**/api/ask', (route) => route.fulfill({ json: {
      ...RESPONSE,
      diagnostics: {
        ...RESPONSE.diagnostics, elapsed_ms: fixture.total,
        activity: [
          { type: 'modelQueryPlanning', elapsed_ms: fixture.planning },
          { type: 'searchIndex', query: 'No matching passage', count: 0 },
          { type: 'modelAnswerSynthesis', elapsed_ms: fixture.writing },
        ],
      },
    } satisfies AskResponse }));
    await page.goto('/');
    await ask(page);
    await page.getByRole('button', { name: 'How this answer was found' }).click();
    const details = page.getByRole('region', { name: 'Retrieval details' });
    await expect(details.getByText('Remaining service time', { exact: true }).locator('..')).toContainText(fixture.remaining);
    await expect(details.getByText('0 matches returned', { exact: true })).toBeVisible();
    if (fixture.total === 0) {
      await expect(details.getByText('0 ms measured', { exact: true })).toHaveCount(2);
    } else {
      await expect(details).toContainText('Reported stage durations exceed the total and may overlap');
    }
  });
}

test('shows every activity error, including structured and unknown-stage errors, without crashing', async ({ page }) => {
  await page.route('**/api/ask', (route) => route.fulfill({ json: {
    ...RESPONSE,
    diagnostics: {
      ...RESPONSE.diagnostics, retrieve_status: 503, gate_passed: false,
      unresolved_ref_ids: ['missing-reference'], incomplete_ref_ids: ['incomplete-reference'],
      activity: [
        null,
        { type: 'modelQueryPlanning', elapsed_ms: 1200, error: 'The planner returned incomplete queries.' },
        { type: 'searchIndex', query: 'TD capital ratio', error: { code: 'SearchTimeout', message: 'TD search timed out.' } },
        { type: 'modelAnswerSynthesis', error: ['Writing interrupted', { code: 'IncompleteOutput' }] },
        { type: 'semanticReranker', error: 42 },
        { type: 'searchIndex', query: null, error: {} },
        { error: 'An unnamed stage failed.' },
      ],
    },
  } }));
  await page.goto('/');
  await ask(page);
  await page.getByRole('button', { name: 'How this answer was found' }).click();
  const details = page.getByRole('region', { name: 'Retrieval details' });
  await expect(details.getByText('Retrieval error', { exact: true })).toBeVisible();
  await expect(details).toContainText('Retrieval returned HTTP 503.');
  const errors = details.getByRole('alert', { name: 'Activity errors' });
  await expect(errors.getByRole('listitem')).toHaveCount(6);
  await expect(errors).toContainText('The planner returned incomplete queries.');
  await expect(errors).toContainText('SearchTimeout');
  await expect(errors).toContainText('TD search timed out.');
  await expect(errors).toContainText('Writing interrupted');
  await expect(errors).toContainText('IncompleteOutput');
  await expect(errors).toContainText('semanticReranker');
  await expect(errors.getByText('42', { exact: true })).toBeVisible();
  await expect(errors).toContainText('The service reported an error without details.');
  await expect(errors).toContainText('Unspecified stage');
  await expect(errors).toContainText('An unnamed stage failed.');
  await expect(details).toContainText('2 citation references were removed');
  await expect(details.getByRole('button', { name: 'Technical details' })).toHaveAttribute('aria-expanded', 'false');
});

for (const viewport of [{ width: 350, height: 800 }, { width: 1024, height: 768 }]) {
  test(`keeps the evidence timeline and disclosures readable in a narrow conversation at ${viewport.width}px`, async ({ page }) => {
    await page.route('**/api/ask', (route) => route.fulfill({ json: {
      ...RESPONSE,
      diagnostics: {
        ...RESPONSE.diagnostics,
        conversation: {
          history_messages_received: 6, history_messages_used: 6, history_messages_omitted: 0,
          estimated_input_tokens: 3250, token_budget: 12000,
        },
        activity: [
          { type: 'modelQueryPlanning', elapsed_ms: 1800 },
          { type: 'searchIndex', query: `Capital adequacy ${'long-query-reference-'.repeat(24)}`, count: 123456 },
          { type: 'modelAnswerSynthesis', elapsed_ms: 2900 },
        ],
      },
    } satisfies AskResponse }));
    await page.setViewportSize(viewport);
    await page.goto('/');
    await ask(page);
    if (viewport.width >= 1024) {
      await page.getByRole('button', { name: 'Source 1:', exact: false }).first().click();
      await page.getByRole('button', { name: 'Expand source panel', exact: true }).click();
    }
    await page.getByRole('button', { name: 'How this answer was found' }).click();
    const details = page.getByRole('region', { name: 'Retrieval details' });
    expect((await bounds(details)).width).toBeLessThan(350);
    await expect(details.getByRole('heading', { name: 'Report search', exact: true })).toBeVisible();
    await expect(details.getByText('123,456 matches returned', { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Technical details' }).click();
    await expect(details.getByText('Cited sentences (heuristic)', { exact: true })).toBeVisible();
    await expect(details.getByText('History messages omitted', { exact: true }).locator('..').locator('dd')).toHaveText('0');
    expect(await details.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await noOverflow(page);
  });
}

test('reports clipboard failure instead of silently failing', async ({ page }) => {
  await page.goto('/');
  await ask(page);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) },
  }));
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not copy');
});

test('responsible AI information is keyboard accessible and does not close the source behind it', async ({ page }) => {
  await page.addInitScript(() => window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') event.preventDefault();
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Library, 2 reports' }).click();
  const trigger = page.getByRole('button', { name: 'Responsible AI', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'About this AI-assisted workspace' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Matching a citation to a passage is not a fact check.', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('link')).toHaveAttribute('href', 'https://www.microsoft.com/en-us/ai/responsible-ai');
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Source viewer' })).toBeVisible();
});

test('supports multiline composition, input limits, IME input, and the slash shortcut', async ({ page }) => {
  await page.goto('/');
  const input = page.getByRole('textbox');
  await input.fill('First line');
  await input.press('Shift+Enter');
  await input.press('a');
  await expect(input).toHaveValue('First line\na');
  await input.fill(' ');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  await input.fill('x'.repeat(2100));
  expect((await input.inputValue()).length).toBe(2000);
  await input.fill(QUESTION);
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('button', { name: 'Responsible AI', exact: true }).focus();
  await page.keyboard.press('/');
  await expect(input).toBeFocused();
  await input.press('Enter');
  await expect(page.locator('.answer-prose')).toBeVisible();
});

for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
  test(`keeps conversation and sources usable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expectFooterLayout(page);
    await noOverflow(page);
    await ask(page);
    await noOverflow(page);
    await page.getByRole('button', { name: 'Source 1:', exact: false }).first().click();
    const panel = page.getByRole('dialog', { name: 'Source viewer' });
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((element) => element.matches(':modal'))).toBe(viewport.width < 1024);
    if (viewport.width >= 1024) await expectPanelInsets(page, panel);
    else {
      const pane = await bounds(panel);
      expect(pane.x).toBeCloseTo(12, 0);
      expect(pane.y).toBeCloseTo(12, 0);
      expect(pane.width).toBeCloseTo(viewport.width - 24, 0);
      expect(pane.height).toBeCloseTo(viewport.height - 24, 0);
    }
    await panel.getByRole('tab', { name: 'Passage' }).click();
    await expect(panel.locator('.passage mark')).toContainText('13.5');
    await noOverflow(page);
    if (viewport.width < 1024) {
      for (let index = 0; index < 10; index++) {
        await page.keyboard.press('Tab');
        expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      }
    }
    await panel.getByRole('button', { name: 'Collapse source panel' }).click();
    await page.getByRole('button', { name: 'Show source panel' }).click();
    await expect(panel.getByRole('tab', { name: 'Passage' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible();
    await expect(page.getByRole('textbox')).toBeVisible();
    await noOverflow(page);
  });
}

test('handles empty and failed library states', async ({ page }) => {
  await page.route('**/api/documents', (route) => route.fulfill({ json: { documents: [] } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Library, 0 reports' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Available reports' })).toHaveCount(0);
  await expect(page.getByText('No reports are indexed yet.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Library, 0 reports' }).click();
  await expect(page.getByText('No reports available')).toBeVisible();
  await page.route('**/api/documents', (route) => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('not responding');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByText("Couldn't load the library")).toBeVisible();
});

test('shows PDF loading errors and retries the document link', async ({ page }) => {
  let available = false;
  await page.route('**/api/docs/**', (route) => !available
    ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    : route.fulfill({ json: { url: 'http://127.0.0.1:5174/test-document' } }));
  await page.goto('/');
  await ask(page);
  await page.getByRole('button', { name: 'Source 1:', exact: false }).first().click();
  const panel = page.getByRole('dialog', { name: 'Source viewer' });
  await expect(panel.getByText("Couldn't open the PDF")).toBeVisible();
  available = true;
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel.locator('iframe')).toHaveAttribute('src', /#page=238&/);
});

test('contains long questions and wide Markdown tables without overflowing the screen', async ({ page }) => {
  const cells = Array.from({ length: 18 }, (_, index) => `Column ${index + 1}`);
  await page.route('**/api/ask', (route) => route.fulfill({ json: {
    ...RESPONSE,
    answer: `| ${cells.join(' | ')} |\n| ${cells.map(() => '---').join(' | ')} |\n| ${cells.map(() => '123,456,789').join(' | ')} |\n\n\`\`\`text\n${'LongCode'.repeat(80)}\n\`\`\``,
  } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await ask(page, 'LongQuestion'.repeat(100));
  await noOverflow(page);
  expect(await page.locator('.user-message').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test('keeps long source excerpts and page labels inside narrow conversation cards', async ({ page }) => {
  await page.route('**/api/ask', (route) => route.fulfill({ json: {
    ...RESPONSE,
    citations: RESPONSE.citations.map((citation) => ({
      ...citation, page_from: 1200, page_to: 1208,
      excerpt: `Capital adequacy measures including ${'nonbreaking-source-reference'.repeat(15)} and CET1 ratio 13.5%.`,
    })),
  } satisfies AskResponse }));
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  await ask(page);
  const sources = page.getByRole('region', { name: 'Sources', exact: true });
  await sources.getByRole('button', { name: 'Sources (2)', exact: true }).click();
  await expect(sources.getByRole('list', { name: 'Source cards' })).toBeVisible();
  await noOverflow(page);
  const main = await bounds(page.getByRole('main'));
  for (const card of await sources.getByRole('list', { name: 'Source cards' }).getByRole('button').all()) {
    const cardBounds = await bounds(card);
    expect(cardBounds.x + cardBounds.width).toBeLessThanOrEqual(main.x + main.width - 10);
  }
});

test('honors reduced motion preferences', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const duration = await page.locator('.animate-fade-up').first().evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThan(0.001);
});

test('does not pull readers away from older messages when an answer arrives', async ({ page }) => {
  await page.route('**/api/ask', (route) => route.fulfill({
    json: { ...RESPONSE, answer: Array(6).fill(RESPONSE.answer).join('\n\n') },
  }));
  await page.goto('/');
  await ask(page);
  let release = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/ask', async (route) => {
    await wait;
    await route.fulfill({ json: { ...RESPONSE, answer: Array(24).fill(RESPONSE.answer).join('\n\n') } });
  });
  await page.getByRole('textbox').fill('Explain the comparison in detail.');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();
  const scroll = page.locator('.conversation-scroll');
  await scroll.evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByRole('button', { name: 'Latest message' })).toBeVisible();
  release();
  await expect(page.locator('.answer-prose')).toHaveCount(2);
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeLessThan(10);
  await page.getByRole('button', { name: 'Latest message' }).click();
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
});

test('switches between desktop and mobile source modes without losing the selected passage', async ({ page }) => {
  await page.goto('/');
  await ask(page);
  await page.getByRole('button', { name: 'Source 1:', exact: false }).first().click();
  const panel = page.getByRole('dialog', { name: 'Source viewer' });
  await panel.getByRole('tab', { name: 'Passage' }).click();
  await expect(panel.locator('.passage')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  expect(await panel.evaluate((element) => element.matches(':modal'))).toBe(true);
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(panel.getByRole('button', { name: 'Expand source panel', exact: true })).toBeVisible();
  expect(await panel.evaluate((element) => element.matches(':modal'))).toBe(false);
  await expect(panel.getByRole('tab', { name: 'Passage' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('.passage mark')).toContainText('13.5');
  await noOverflow(page);
});
