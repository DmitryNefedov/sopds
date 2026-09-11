import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { mimeFor, translitName, zipWrap } from '../src/utils/download.js';
import { qstr } from '../src/utils/http.js';

// The leaf helpers that shape a response: media types, download filenames and
// the query-string utility the routes lean on. Language grouping lives in
// test/lang.test.ts.

test('mimeFor maps each known format and falls back to octet-stream', () => {
  assert.equal(mimeFor('fb2'), 'application/fb2+xml');
  assert.equal(mimeFor('epub'), 'application/epub+zip');
  assert.equal(mimeFor('mobi'), 'application/x-mobipocket-ebook');
  assert.equal(mimeFor('pdf'), 'application/pdf');
  assert.equal(mimeFor('djvu'), 'image/vnd.djvu');
  assert.equal(mimeFor('zip'), 'application/zip');
  assert.equal(mimeFor('cbz'), 'application/octet-stream', 'unknown format');
  assert.equal(mimeFor(''), 'application/octet-stream', 'empty format');
});

// Every entry of the transliteration table, so dropping or changing any one
// mapping is caught. Latin/space/punctuation handling is checked separately.
const TRANSLIT_PAIRS: Array<[string, string]> = [
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['е', 'e'],
  ['ё', 'e'], ['ж', 'zh'], ['з', 'z'], ['и', 'i'], ['й', 'j'], ['к', 'k'],
  ['л', 'l'], ['м', 'm'], ['н', 'n'], ['о', 'o'], ['п', 'p'], ['р', 'r'],
  ['с', 's'], ['т', 't'], ['у', 'u'], ['ф', 'f'], ['х', 'h'], ['ы', 'y'],
  ['э', 'e'], ['ж', 'zh'], ['ц', 'ts'], ['ч', 'ch'], ['ш', 'sh'], ['щ', 'sch'],
  ['ю', 'ju'], ['я', 'ja'], ['ъ', ''], ['ь', ''],
];

test('translitName transliterates every Cyrillic letter in the table', () => {
  for (const [cyr, lat] of TRANSLIT_PAIRS) {
    // Wrap in a stable Latin frame so an empty mapping still yields a name.
    assert.equal(translitName(`x${cyr}x`), `x${lat}x`, `${cyr} -> "${lat}"`);
  }
  // And a whole word, to catch a mapping that only breaks in sequence.
  assert.equal(translitName('Ночной Дозор'), 'nochnoj_dozor');
  assert.equal(translitName('Война и мир, том 1'), 'vojna_i_mir_tom_1');
});

test('translitName keeps ASCII word characters and maps spaces to underscore', () => {
  assert.equal(translitName('Hitchhiker\'s Guide'), 'hitchhikers_guide');
  assert.equal(translitName('a.b_c-d1'), 'a.b_c-d1', '. _ - and digits pass through');
  assert.equal(translitName('ABC'), 'abc', 'upper-case ASCII is lowered and kept');
  assert.equal(translitName('one two'), 'one_two', 'space -> underscore');
});

test('translitName collapses and trims underscores, dropping unknown characters', () => {
  assert.equal(translitName('  spaced   out  '), 'spaced_out', 'leading+trailing runs trimmed');
  assert.equal(translitName('a???b'), 'ab', 'unknown chars are dropped, not spaced');
  assert.equal(translitName('a  b  c'), 'a_b_c', 'every internal run collapses, not just the first');
});

test('translitName never yields an empty or unsafe name', () => {
  assert.equal(translitName(''), 'book');
  assert.equal(translitName('???'), 'book', 'nothing survives -> fallback');
  assert.equal(translitName('   '), 'book', 'only separators -> fallback');
  assert.equal(translitName('../../etc/passwd'), '....etcpasswd', 'no path separators survive');
  assert.ok(!translitName('a/b\\c:d').includes('/'));
  assert.ok(!translitName('a/b\\c:d').includes('\\'));
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
