import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Run against the in-process PostgreSQL (PGlite) unless told otherwise.
process.env.SOPDS_TEST_DB ??= 'mem';

const { default: db, initSchema, updateCounters } = await import('../src/db.js');
const repo = await import('../src/repo.js');
const { loadSettings } = await import('../src/settings.js');
const { normalize } = await import('../src/lang.js');

const TABLES = [
  'book_authors', 'book_series', 'book_genres',
  'books', 'authors', 'series', 'catalogs', 'counters',
];

before(async () => {
  await initSchema();
  await loadSettings();
  await db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);

  const addBook = (filename: string, title: string) =>
    db.get<{ id: number }>(
      `INSERT INTO books (filename, path, format, title, search_title, lang_code, avail)
       VALUES (?, 'r', 'fb2', ?, ?, 1, 2) RETURNING id`,
      [filename, title, normalize(title)],
    );
  const addAuthor = (name: string) =>
    db.get<{ id: number }>(
      'INSERT INTO authors (full_name, search_full_name, lang_code) VALUES (?, ?, 1) RETURNING id',
      [name, normalize(name)],
    );
  const addSeries = (name: string) =>
    db.get<{ id: number }>(
      'INSERT INTO series (ser, search_ser, lang_code) VALUES (?, ?, 1) RETURNING id',
      [name, normalize(name)],
    );

  const b1 = (await addBook('nd.fb2', 'Night Watch'))!.id;
  const b2 = (await addBook('dd.fb2', 'Day Watch'))!.id;
  const b3 = (await addBook('wp.fb2', 'War and Peace'))!.id;
  const a1 = (await addAuthor('Lukyanenko Sergey'))!.id;
  const a2 = (await addAuthor('Tolstoy Leo'))!.id;
  const s1 = (await addSeries('Watch'))!.id;

  await db.run('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)', [b1, a1]);
  await db.run('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)', [b2, a1]);
  await db.run('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)', [b3, a2]);
  await db.run('INSERT INTO book_series (book_id, ser_id, ser_no) VALUES (?, ?, 1)', [b1, s1]);
  await db.run('INSERT INTO book_series (book_id, ser_id, ser_no) VALUES (?, ?, 2)', [b2, s1]);
  await updateCounters();
});

after(async () => {
  await db.end();
});

test('cross-entity search matches by book title', async () => {
  const r = await repo.searchBooks('war and peace');
  assert.equal(r.total, 1);
  assert.equal(r.items[0].title, 'War and Peace');
});

test('cross-entity search matches books by author name', async () => {
  const r = await repo.searchBooks('lukyanenko');
  assert.equal(r.total, 2);
  assert.deepEqual(
    r.items.map((b) => b.title).sort(),
    ['Day Watch', 'Night Watch'],
  );
});

test('cross-entity search matches books by series name', async () => {
  const r = await repo.searchBooks('watch');
  // "Watch" hits both titles AND the series name; still deduped to 2 books.
  assert.equal(r.total, 2);
});

test('searchAll returns a preview of every entity type', async () => {
  const r = await repo.searchAll('watch');
  assert.equal(r.authors.total, 0);
  assert.equal(r.series.total, 1);
  assert.equal(r.books.total, 2);
});

test('author and series searches are independent', async () => {
  assert.equal((await repo.searchAuthors('tolstoy')).total, 1);
  assert.equal((await repo.searchSeries('watch')).total, 1);
});
