import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { mimeFor, translitName, zipWrap } from '../src/utils/download.js';
import { qstr } from '../src/utils/http.js';

// The leaf helpers that shape a response: media types, download filenames and
// the query-string utility the routes lean on. Language grouping lives in
// test/lang.test.ts.

test('mimeFor knows the book formats and falls back to octet-stream', () => {
  assert.equal(mimeFor('fb2'), 'application/fb2+xml');
  assert.equal(mimeFor('epub'), 'application/epub+zip');
  assert.equal(mimeFor('mobi'), 'application/x-mobipocket-ebook');
  assert.equal(mimeFor('pdf'), 'application/pdf');
  assert.equal(mimeFor('djvu'), 'image/vnd.djvu');
  assert.equal(mimeFor('cbz'), 'application/octet-stream');
});

test('translitName turns a title into an ASCII filename', () => {
  assert.equal(translitName('Ночной Дозор'), 'nochnoj_dozor');
  assert.equal(translitName('Hitchhiker\'s Guide'), 'hitchhikers_guide');
  assert.equal(translitName('  spaced   out  '), 'spaced_out');
  assert.equal(translitName('Война и мир, том 1'), 'vojna_i_mir_tom_1');
});

test('translitName never yields an empty or unsafe name', () => {
  assert.equal(translitName(''), 'book');
  assert.equal(translitName('???'), 'book');
  assert.equal(translitName('../../etc/passwd'), '....etcpasswd', 'no path separators survive');
  assert.ok(!translitName('a/b\\c:d').includes('/'));
});

test('zipWrap produces a readable one-entry archive', () => {
  const buf = zipWrap(Buffer.from('hello'), 'book.fb2');
  const entries = new AdmZip(buf).getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entryName, 'book.fb2');
  assert.equal(entries[0].getData().toString(), 'hello');
});

test('qstr takes the first value of a repeated query param', () => {
  assert.equal(qstr('one'), 'one');
  assert.equal(qstr(['first', 'second']), 'first');
  assert.equal(qstr([]), '');
  assert.equal(qstr(undefined), '');
  assert.equal(qstr(undefined, 'all'), 'all');
  assert.equal(qstr(['first'], 'fallback-ignored'), 'first');
  assert.equal(qstr({ nested: true } as unknown), '');
  assert.equal(qstr(42 as unknown, 'x'), 'x');
});
