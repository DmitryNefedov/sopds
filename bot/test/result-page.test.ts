import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResultPage, hasButtons } from '../src/telegram/result-page.js';
import type { BotBook, BotPage } from '../src/catalog/api-client.js';
import { moreData, pickData } from '../src/telegram/callback.js';

const book = (id: number, title: string, authors: string[] = [], over: Partial<BotBook> = {}): BotBook => ({
  id,
  title,
  format: 'fb2',
  filesize: 1,
  lang: '',
  annotation: '',
  doc_date: '',
  authors: authors.map((full_name, i) => ({ id: i, full_name })),
  series: [],
  genres: [],
  ...over,
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

test('one media item (by book id, not a URL) and one pick button per book, in the same order', () => {
  const p = page([book(1, 'A'), book(2, 'B')]);
  const rp = buildResultPage(p, 'tok', false);
  assert.deepEqual(rp.media.map((m) => m.bookId), [1, 2]);
  assert.deepEqual(
    rp.keyboard.inline_keyboard.map((row) => row.map((b) => ('callback_data' in b ? b.callback_data : null))),
    [[pickData(1)], [pickData(2)]],
  );
});

test('a "More" button is appended only when the page has_next', () => {
  const withMore = buildResultPage(page([book(1, 'A')], { has_next: true }), 'tok', false);
  const last = withMore.keyboard.inline_keyboard.at(-1)!;
  assert.deepEqual(last.map((b) => ('callback_data' in b ? b.callback_data : null)), [moreData('tok')]);

  const withoutMore = buildResultPage(page([book(1, 'A')], { has_next: false }), 'tok', false);
  assert.equal(withoutMore.keyboard.inline_keyboard.length, 1, 'no extra row for More');
});

test('an empty page has no media and no buttons, and says so', () => {
  const rp = buildResultPage(page([]), '', false);
  assert.deepEqual(rp.media, []);
  assert.equal(hasButtons(rp), false);
  assert.equal(rp.summary, 'No books found.');
});

test('the summary labels a title-anywhere fallback page differently from a prefix hit', () => {
  const prefix = buildResultPage(page([book(1, 'A')]), 'tok', false);
  const anywhere = buildResultPage(page([book(1, 'A')]), 'tok', true);
  assert.match(prefix.summary, /title starts with/);
  assert.match(anywhere.summary, /title contains/);
});

test('button label and caption include the author when present, both numbered by position 1', () => {
  const rp = buildResultPage(page([book(1, 'Dune', ['Frank Herbert'])]), 'tok', false);
  assert.equal(rp.media[0].caption, '1. Dune — Frank Herbert');
});

test('caption carries non-Latin text (e.g. Cyrillic titles) through unchanged', () => {
  const rp = buildResultPage(page([book(1, 'Ночной дозор', ['Сергей Лукьяненко'])]), 'tok', false);
  assert.equal(rp.media[0].caption, '1. Ночной дозор — Сергей Лукьяненко');
});

test('caption also carries series, language, and annotation, so covers alone are not the only way to tell books apart', () => {
  const b = book(1, 'Dune', ['Frank Herbert'], {
    series: [{ id: 1, ser: 'Dune', ser_no: 1 }],
    lang: 'ru',
    annotation: 'A desert planet, a spice, a prophecy.',
  });
  const rp = buildResultPage(page([b]), 'tok', false);
  assert.equal(
    rp.media[0].caption,
    '1. Dune — Frank Herbert\nSeries: Dune #1\nLanguage: ru\n\nA desert planet, a spice, a prophecy.',
  );
});

test('the pick button label is a numbered title/author, independent of the fuller caption', () => {
  const b = book(1, 'Dune', ['Frank Herbert'], {
    series: [{ id: 1, ser: 'Dune', ser_no: 1 }],
    lang: 'ru',
    annotation: 'A desert planet, a spice, a prophecy.',
  });
  const rp = buildResultPage(page([b]), 'tok', false);
  const [[button]] = rp.keyboard.inline_keyboard;
  assert.equal(button.text, '1. Dune — Frank Herbert');
});

test('each book on a page is numbered by its position, and the caption and pick button agree on the number', () => {
  const rp = buildResultPage(page([book(1, 'A'), book(2, 'B'), book(3, 'C')]), 'tok', false);
  assert.deepEqual(
    rp.media.map((m) => m.caption),
    ['1. A', '2. B', '3. C'],
  );
  assert.deepEqual(
    rp.keyboard.inline_keyboard.map((row) => row[0].text),
    ['1. A', '2. B', '3. C'],
  );
});
