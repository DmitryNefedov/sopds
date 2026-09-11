import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResultPage, hasButtons } from '../src/result-page.js';
import { CatalogClient } from '../src/api-client.js';
import type { BotBook, BotPage } from '../src/api-client.js';
import { moreData, pickData } from '../src/callback.js';

const api = new CatalogClient({ baseUrl: 'http://api.local' });

const book = (id: number, title: string, authors: string[] = []): BotBook => ({
  id,
  title,
  format: 'fb2',
  filesize: 1,
  authors: authors.map((full_name, i) => ({ id: i, full_name })),
  series: [],
});

const page = (items: BotBook[], over: Partial<BotPage<BotBook>> = {}): BotPage<BotBook> => ({
  items,
  total: items.length,
  page: 1,
  limit: 5,
  pages: 1,
  has_next: false,
  has_prev: false,
  ...over,
});

test('one media item and one pick button per book, in the same order', () => {
  const p = page([book(1, 'A'), book(2, 'B')]);
  const rp = buildResultPage(api, p, 'tok', false);
  assert.deepEqual(rp.media.map((m) => m.media), [api.coverUrl(1), api.coverUrl(2)]);
  assert.deepEqual(
    rp.keyboard.inline_keyboard.map((row) => row.map((b) => ('callback_data' in b ? b.callback_data : null))),
    [[pickData(1)], [pickData(2)]],
  );
});

test('a "More" button is appended only when the page has_next', () => {
  const withMore = buildResultPage(api, page([book(1, 'A')], { has_next: true }), 'tok', false);
  const last = withMore.keyboard.inline_keyboard.at(-1)!;
  assert.deepEqual(last.map((b) => ('callback_data' in b ? b.callback_data : null)), [moreData('tok')]);

  const withoutMore = buildResultPage(api, page([book(1, 'A')], { has_next: false }), 'tok', false);
  assert.equal(withoutMore.keyboard.inline_keyboard.length, 1, 'no extra row for More');
});

test('an empty page has no media and no buttons, and says so', () => {
  const rp = buildResultPage(api, page([]), '', false);
  assert.deepEqual(rp.media, []);
  assert.equal(hasButtons(rp), false);
  assert.equal(rp.summary, 'No books found.');
});

test('the summary labels a title-anywhere fallback page differently from a prefix hit', () => {
  const prefix = buildResultPage(api, page([book(1, 'A')]), 'tok', false);
  const anywhere = buildResultPage(api, page([book(1, 'A')]), 'tok', true);
  assert.match(prefix.summary, /title starts with/);
  assert.match(anywhere.summary, /title contains/);
});

test('button label and caption include the author when present', () => {
  const rp = buildResultPage(api, page([book(1, 'Dune', ['Frank Herbert'])]), 'tok', false);
  assert.equal(rp.media[0].caption, 'Dune — Frank Herbert');
});
