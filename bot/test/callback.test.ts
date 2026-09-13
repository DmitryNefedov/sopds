import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moreData,
  pickData,
  downloadData,
  parseCallback,
  MAX_CALLBACK_DATA_BYTES,
} from '../src/telegram/callback.js';

test('moreData/pickData/downloadData round-trip through parseCallback', () => {
  assert.deepEqual(parseCallback(moreData('abc12345')), { kind: 'more', token: 'abc12345' });
  assert.deepEqual(parseCallback(pickData(42)), { kind: 'pick', bookId: 42 });
  assert.deepEqual(parseCallback(downloadData(42, 'epub')), {
    kind: 'download',
    bookId: 42,
    format: 'epub',
  });
});

test('a page-worth of buttons fits inside the 64-byte callback_data budget', () => {
  // An 8-char session token plus a book id up to 7 digits is what a real
  // "more"/"pick"/"download" button actually has to carry.
  const token = 'a'.repeat(8);
  const bookId = 9_999_999;
  for (const data of [moreData(token), pickData(bookId), downloadData(bookId, 'epub')]) {
    assert.ok(
      Buffer.byteLength(data, 'utf8') <= MAX_CALLBACK_DATA_BYTES,
      `${data} is ${Buffer.byteLength(data, 'utf8')} bytes`,
    );
  }
});

test('parseCallback rejects malformed data instead of throwing', () => {
  for (const bad of ['', 'x', 'p:', 'p:abc', 'd:1', 'd:1:', 'd:abc:epub', 'm:', 'unknown:1']) {
    assert.equal(parseCallback(bad), null, JSON.stringify(bad));
  }
});
