import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSearch, moreResults } from '../src/search/search-flow.js';
import { CatalogClient } from '../src/catalog/api-client.js';
import type { BotBook, BotPage } from '../src/catalog/api-client.js';
import { clearAllSessions, getSession } from '../src/search/session.js';
import { hasButtons } from '../src/telegram/result-page.js';

const book = (id: number): BotBook => ({
  id,
  title: `Book ${id}`,
  format: 'fb2',
  filesize: 1,
  lang: '',
  annotation: '',
  doc_date: '',
  authors: [],
  series: [],
  genres: [],
});

const emptyPage: BotPage<BotBook> = {
  items: [],
  total: 0,
  page: 1,
  limit: 5,
  pages: 1,
  has_next: false,
  has_prev: false,
};

function fullPage(items: BotBook[], over: Partial<BotPage<BotBook>> = {}): BotPage<BotBook> {
  return { ...emptyPage, items, total: items.length, ...over };
}

test.beforeEach(() => clearAllSessions());

test('a prefix hit never calls the fallback and starts a session in "prefix" mode', async () => {
  let anywhereCalled = false;
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/search') anywhereCalled = true;
      return new Response(JSON.stringify(fullPage([book(1), book(2)])), { status: 200 });
    }) as typeof fetch,
  });

  const outcome = await runSearch(client, 'hob');
  assert.equal(anywhereCalled, false);
  assert.ok(outcome.token);
  assert.equal(getSession(outcome.token!)!.mode, 'prefix');
  assert.equal(outcome.page.media.length, 2);
});

test('an empty prefix pass falls back to the title-anywhere search and labels the session "anywhere"', async () => {
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/books') {
        return new Response(JSON.stringify(emptyPage), { status: 200 });
      }
      return new Response(
        JSON.stringify({ query: 'q', type: 'books', match: 'all', results: fullPage([book(9)]) }),
        { status: 200 },
      );
    }) as typeof fetch,
  });

  const outcome = await runSearch(client, 'q');
  assert.ok(outcome.token);
  assert.equal(getSession(outcome.token!)!.mode, 'anywhere');
  assert.match(outcome.page.summary, /title contains/);
});

test('both passes empty: no session is created, and the caller gets no buttons to show', async () => {
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () => new Response(JSON.stringify(emptyPage), { status: 200 })) as typeof fetch,
  });

  const outcome = await runSearch(client, 'nothing-matches-this');
  assert.equal(outcome.token, null);
  assert.equal(hasButtons(outcome.page), false);
  assert.equal(outcome.page.summary, 'No books found.');
});

test('moreResults advances the session to the next page and re-fetches with it', async () => {
  const seenPages: number[] = [];
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async (input: string) => {
      const url = new URL(input);
      seenPages.push(Number(url.searchParams.get('page')));
      return new Response(JSON.stringify(fullPage([book(1)], { has_next: true })), { status: 200 });
    }) as typeof fetch,
  });

  const first = await runSearch(client, 'q');
  const outcome = await moreResults(client, first.token!);
  assert.ok(outcome);
  assert.deepEqual(seenPages, [1, 2]);
  assert.equal(getSession(first.token!)!.page, 2);
});

test('moreResults on a gone token returns null rather than guessing', async () => {
  const client = new CatalogClient({ baseUrl: 'http://api.local' });
  assert.equal(await moreResults(client, 'unknown-token'), null);
});
