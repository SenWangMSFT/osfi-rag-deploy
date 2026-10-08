import { expect, test, type Page } from '@playwright/test';
import type { AskResponse, HistoryMessage, Turn } from '../src/types';

const STORAGE_KEY = 'osfi-rag.conversation.v1';
const response: AskResponse = {
  answer: 'The annual reports provide the supporting information.',
  citations: [], warnings: [],
  diagnostics: {
    elapsed_ms: 100, retrieve_status: 200, gate_passed: false, reference_count: 0, citation_count: 0,
    uncited_reference_count: 0, unresolved_ref_ids: [], incomplete_ref_ids: [],
    grounded_sentence_ratio: null, sentences_total: 1, sentences_grounded: 0,
    input_tokens: 100, output_tokens: 20, reasoning_tokens: 0, activity: [],
  },
};

async function mockApi(page: Page, requests: HistoryMessage[][]) {
  await page.route('**/api/documents', (route) => route.fulfill({ json: { documents: [] } }));
  await page.route('**/api/ask', async (route) => {
    const body: { question: string; history: HistoryMessage[] } = route.request().postDataJSON();
    requests.push(body.history);
    await route.fulfill({ json: {
      ...response,
      diagnostics: {
        ...response.diagnostics,
        conversation: {
          history_messages_received: body.history.length, history_messages_used: body.history.length,
          history_messages_omitted: 0, estimated_input_tokens: 100, token_budget: 898_000,
        },
      },
    } satisfies AskResponse });
  });
}

test('restores over 30 turns and sends every completed exchange after reload', async ({ page }) => {
  const requests: HistoryMessage[][] = [];
  await mockApi(page, requests);
  const seed: Turn[] = Array.from({ length: 40 }, (_, index) => ({
    id: `history-${index}`, question: `Question ${index}: compare annual reports.`,
    askedAt: index, status: 'done', response: { ...response, answer: `Answer ${index}: source-backed text.[1]` },
  }));
  await page.addInitScript(({ key, turns }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(turns));
  }, { key: STORAGE_KEY, turns: seed });
  await page.goto('/');
  await expect(page.getByRole('article')).toHaveCount(40);
  await page.getByRole('textbox').fill('Continue the first comparison.');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.answer-prose')).toHaveCount(41);
  expect(requests[0]).toHaveLength(80);
  expect(requests[0][0].text).toBe(seed[0].question);
  expect(requests[0][1].text).toBe('Answer 0: source-backed text.');
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]').length, STORAGE_KEY)).toBe(41);
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(41);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('textbox').fill('Start over.');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.answer-prose')).toHaveCount(1);
  expect(requests[1]).toEqual([]);
});

test('storage quota failures are visible without preventing multi-turn chat', async ({ page }) => {
  const requests: HistoryMessage[][] = [];
  await mockApi(page, requests);
  await page.addInitScript(() => Object.defineProperty(Storage.prototype, 'setItem', {
    value: () => { throw new DOMException('Storage is full.', 'QuotaExceededError'); },
  }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('could not be saved to browser storage');
  for (let index = 1; index <= 2; index++) {
    await page.getByRole('textbox').fill(`Follow up ${index}`);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.locator('.answer-prose')).toHaveCount(index);
  }
  expect(requests[1]).toHaveLength(2);
  await expect(page.getByRole('alert')).toContainText('You can keep chatting');
});

test('context-window omissions are surfaced while the older chat remains visible', async ({ page }) => {
  await mockApi(page, []);
  await page.goto('/');
  await page.getByRole('textbox').fill('First question.');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.answer-prose')).toHaveCount(1);
  await page.route('**/api/ask', (route) => route.fulfill({ json: {
    ...response,
    warnings: ['Conversation context: 2 earlier messages were left out of this answer to stay within the context limit. They remain in your chat; restate older details if needed.'],
    diagnostics: {
      ...response.diagnostics,
      conversation: {
        history_messages_received: 2, history_messages_used: 0, history_messages_omitted: 2,
        estimated_input_tokens: 50, token_budget: 60,
      },
    },
  } satisfies AskResponse }));
  await page.getByRole('textbox').fill('Follow-up question.');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.answer-prose')).toHaveCount(2);
  await expect(page.getByText('2 earlier messages were left out', { exact: false })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(2);
});

test('invalid saved history shows a restore warning rather than silently disappearing', async ({ page }) => {
  await mockApi(page, []);
  await page.addInitScript((key) => localStorage.setItem(key, '{invalid'), STORAGE_KEY);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('saved conversation could not be restored');
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe('{invalid');
  await page.getByRole('textbox').fill('A new question.');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.answer-prose')).toHaveCount(1);
});
