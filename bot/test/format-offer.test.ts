import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOffer } from '../src/format-offer.js';
import type { BotBook } from '../src/api-client.js';

const book = (over: Partial<BotBook>): BotBook => ({
  id: 1,
  title: 'T',
  format: 'fb2',
  filesize: 100,
  authors: [],
  series: [],
  ...over,
});

test('a convertible native format offers every convertible target, matching download_formats', () => {
  // GET /api/books/:id shape when the source (fb2) is convertible: every
  // target comes back convertible: true, regardless of native/isSource.
  const b = book({
    format: 'fb2',
    download_formats: [
      { format: 'fb2', native: true, convertible: true, url: '/x' },
      { format: 'epub', native: false, convertible: true, url: '/x' },
      { format: 'mobi', native: false, convertible: true, url: '/x' },
    ],
  });
  assert.deepEqual(formatOffer(b), ['fb2', 'epub', 'mobi']);
});

test('a non-convertible native format (pdf) offers only itself, restoring what download_formats omits', () => {
  const b = book({
    format: 'pdf',
    download_formats: [
      { format: 'fb2', native: false, convertible: false, url: '/x' },
      { format: 'epub', native: false, convertible: false, url: '/x' },
      { format: 'mobi', native: false, convertible: false, url: '/x' },
    ],
  });
  assert.deepEqual(formatOffer(b), ['pdf']);
});

test('missing download_formats (e.g. a book fetched without the API attaching it) falls back to the native format', () => {
  assert.deepEqual(formatOffer(book({ format: 'djvu', download_formats: undefined })), ['djvu']);
});
