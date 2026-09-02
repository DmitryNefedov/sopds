import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-test-'));
process.env.SOPDS_DB = path.join(tmp, 'test.db');
process.env.SOPDS_ROOT_LIB = path.join(tmp, 'books');

const { default: db, initSchema, updateCounters } = await import('../src/db.js');
const repo = await import('../src/repo.js');
const { normalize } = await import('../src/lang.js');

before(() => {
  initSchema();
  const book = db.prepare(
    `INSERT INTO books (filename, path, format, title, search_title, lang_code, avail)
     VALUES (?, ?, 'fb2', ?, ?, 1, 2)`,
  );
  const author = db.prepare(
    'INSERT INTO authors (full_name, search_full_name, lang_code) VALUES (?, ?, 1)',
  );
  const series = db.prepare(
    'INSERT INTO series (ser, search_ser, lang_code) VALUES (?, ?, 1)',
  );
  const link = db.prepare(
    'INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)',
  );
  const linkS = db.prepare(
    'INSERT INTO book_series (book_id, ser_id, ser_no) VALUES (?, ?, ?)',
  );

  const b1 = Number(
    book.run('nd.fb2', 'r', 'Night Watch', normalize('Night Watch')).lastInsertRowid,
  );
  const b2 = Number(
    book.run('dd.fb2', 'r', 'Day Watch', normalize('Day Watch')).lastInsertRowid,
  );
  const b3 = Number(
    book.run('wp.fb2', 'r', 'War and Peace', normalize('War and Peace')).lastInsertRowid,
  );
  const a1 = Number(
    author.run('Lukyanenko Sergey', normalize('Lukyanenko Sergey')).lastInsertRowid,
  );
  const a2 = Number(
    author.run('Tolstoy Leo', normalize('Tolstoy Leo')).lastInsertRowid,
  );
  const s1 = Number(series.run('Watch', normalize('Watch')).lastInsertRowid);
  link.run(b1, a1);
  link.run(b2, a1);
  link.run(b3, a2);
  linkS.run(b1, s1, 1);
  linkS.run(b2, s1, 2);
  updateCounters();
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('cross-entity search matches by book title', () => {
  const r = repo.searchBooks('war and peace');
  assert.equal(r.total, 1);
  assert.equal(r.items[0].title, 'War and Peace');
});

test('cross-entity search matches books by author name', () => {
  const r = repo.searchBooks('lukyanenko');
  assert.equal(r.total, 2);
  assert.deepEqual(
    r.items.map((b) => b.title).sort(),
    ['Day Watch', 'Night Watch'],
  );
});

test('cross-entity search matches books by series name', () => {
  const r = repo.searchBooks('watch');
  // "Watch" hits both titles AND the series name; still deduped to 2 books.
  assert.equal(r.total, 2);
});

test('searchAll returns a preview of every entity type', () => {
  const r = repo.searchAll('watch');
  assert.equal(r.authors.total, 0);
  assert.equal(r.series.total, 1);
  assert.equal(r.books.total, 2);
});

test('author and series searches are independent', () => {
  assert.equal(repo.searchAuthors('tolstoy').total, 1);
  assert.equal(repo.searchSeries('watch').total, 1);
});
