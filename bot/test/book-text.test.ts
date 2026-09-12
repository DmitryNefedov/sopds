import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookLine, bookCaption, formatBookDetails, CAPTION_LIMIT } from '../src/book-text.js';
import type { BotBook } from '../src/api-client.js';

const book = (over: Partial<BotBook> = {}): BotBook => ({
  id: 1,
  title: 'Dune',
  format: 'fb2',
  filesize: 2_667_000,
  lang: '',
  annotation: '',
  doc_date: '',
  authors: [],
  series: [],
  genres: [],
  ...over,
});

test('bookLine is a bare title with no authors', () => {
  assert.equal(bookLine(book()), 'Dune');
});

test('bookLine appends every author', () => {
  assert.equal(
    bookLine(book({ authors: [{ id: 1, full_name: 'Frank Herbert' }] })),
    'Dune — Frank Herbert',
  );
});

test('bookLine prefixes its position number when given one, ahead of the title', () => {
  assert.equal(bookLine(book(), 3), '3. Dune');
});

test('bookCaption is just the numbered bookLine when there is nothing else to say', () => {
  assert.equal(bookCaption(book(), 1), '1. Dune');
});

test('bookCaption adds series (with its number), language, and the annotation, in that order, after the position number', () => {
  const b = book({
    authors: [{ id: 1, full_name: 'Frank Herbert' }],
    series: [{ id: 1, ser: 'Dune', ser_no: 1 }],
    lang: 'ru',
    annotation: 'A desert planet, a spice, a prophecy.',
  });
  assert.equal(
    bookCaption(b, 1),
    '1. Dune — Frank Herbert\nSeries: Dune #1\nLanguage: ru\n\nA desert planet, a spice, a prophecy.',
  );
});

test('bookCaption omits a series number of 0 (standalone entries in a series)', () => {
  const b = book({ series: [{ id: 1, ser: 'Miscellanea', ser_no: 0 }] });
  assert.equal(bookCaption(b, 2), '2. Dune\nSeries: Miscellanea');
});

test('bookCaption joins multiple series with a comma', () => {
  const b = book({
    series: [
      { id: 1, ser: 'Dune', ser_no: 1 },
      { id: 2, ser: 'Golden Library', ser_no: 3 },
    ],
  });
  assert.equal(bookCaption(b, 1), '1. Dune\nSeries: Dune #1, Golden Library #3');
});

test('bookCaption is truncated to the Telegram photo caption limit', () => {
  const b = book({ annotation: 'x'.repeat(2000) });
  const caption = bookCaption(b, 1);
  assert.equal(caption.length, CAPTION_LIMIT);
  assert.ok(caption.startsWith('1. Dune\n\nxxx'));
});

test('formatBookDetails includes everything bookCaption does, plus genres, format, size, and date', () => {
  const b = book({
    authors: [{ id: 1, full_name: 'Frank Herbert' }],
    series: [{ id: 1, ser: 'Dune', ser_no: 1 }],
    genres: [{ id: 1, genre: 'sf', section: 'Fiction', subsection: 'Science Fiction' }],
    lang: 'ru',
    doc_date: '1965-08-01',
    filesize: 2_667_520,
    format: 'fb2',
    annotation: 'A desert planet, a spice, a prophecy.',
  });
  assert.equal(
    formatBookDetails(b),
    [
      'Dune — Frank Herbert',
      'Series: Dune #1',
      'Genres: Science Fiction',
      'FB2 · 2605 KB · 1965-08-01 · ru',
      '',
      'A desert planet, a spice, a prophecy.',
    ].join('\n'),
  );
});

test('formatBookDetails drops metadata fields that are absent rather than printing them empty', () => {
  assert.equal(formatBookDetails(book({ format: '', filesize: 0 })), 'Dune');
});

test('formatBookDetails is not truncated to the (much shorter) caption limit', () => {
  const b = book({ annotation: 'x'.repeat(2000) });
  assert.ok(formatBookDetails(b).length > CAPTION_LIMIT);
});
