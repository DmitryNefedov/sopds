import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Run against the in-process PostgreSQL (PGlite) unless told otherwise.
process.env.SOPDS_TEST_DB ??= 'mem';

const { default: db, initSchema, updateCounters, ensureSearchIndexes } = await import('../src/db.js');
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

// The books search collects matching ids from three sources and unions them.
// A book reachable by more than one of those must still appear exactly once,
// and the total has to agree with the rows on every page.

test('a book matched by title, author and series is returned once', async () => {
  // "Watch" hits both book titles and the series; "Lukyanenko" hits the author
  // of the same two books. A query matching every branch must not duplicate.
  const r = await repo.searchBooks('watch');
  assert.equal(r.total, 2);
  assert.equal(r.items.length, 2);
  assert.equal(new Set(r.items.map((b) => b.id)).size, 2, 'no duplicate rows');
});

test('the total agrees with the rows across pages', async () => {
  const first = await repo.searchBooks('watch', { page: 1, limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.items.length, 1);
  assert.equal(first.pages, 2);
  assert.equal(first.has_next, true);

  const second = await repo.searchBooks('watch', { page: 2, limit: 1 });
  assert.equal(second.total, 2, 'the count is the same on a later page');
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0].id, first.items[0].id);

  // Past the end there are no rows to carry the count, so it is fetched
  // separately — it must still be right.
  const past = await repo.searchBooks('watch', { page: 9, limit: 1 });
  assert.equal(past.items.length, 0);
  assert.equal(past.total, 2);
});

test('a query matching nothing reports zero rather than failing', async () => {
  const r = await repo.searchBooks('zzzz-nothing-matches');
  assert.equal(r.total, 0);
  assert.deepEqual(r.items, []);
});

test('unavailable books are excluded from every branch', async () => {
  const id = (await db.get<{ id: number }>("SELECT id FROM books WHERE title = 'Night Watch'"))!.id;
  await db.run('UPDATE books SET avail = 0 WHERE id = ?', [id]);
  try {
    // Reachable by title, by its author and by its series — none may return it.
    for (const q of ['night watch', 'lukyanenko', 'watch']) {
      const r = await repo.searchBooks(q);
      assert.ok(!r.items.some((b) => b.id === id), `"${q}" must not return an unavailable book`);
      assert.equal(r.total, r.items.length, `"${q}" total counts only what it returns`);
    }
  } finally {
    await db.run('UPDATE books SET avail = 2 WHERE id = ?', [id]);
  }
});

test('a page of books is hydrated in full', async () => {
  // Hydration is batched across the page; each book must still get its own
  // authors, genres and series rather than another book's.
  const r = await repo.searchBooks('watch', { page: 1, limit: 10 });
  const night = r.items.find((b) => b.title === 'Night Watch')!;
  const day = r.items.find((b) => b.title === 'Day Watch')!;
  assert.deepEqual(night.authors.map((a) => a.full_name), ['Lukyanenko Sergey']);
  assert.deepEqual(day.authors.map((a) => a.full_name), ['Lukyanenko Sergey']);
  assert.deepEqual(night.series.map((s) => s.ser), ['Watch']);
  assert.equal(night.series[0].ser_no, 1);
  assert.equal(day.series[0].ser_no, 2, 'series number belongs to the right book');

  const war = (await repo.searchBooks('war and peace')).items[0];
  assert.deepEqual(war.authors.map((a) => a.full_name), ['Tolstoy Leo']);
  assert.deepEqual(war.series, [], 'a book with no series gets an empty list');
});

test('batched hydration matches hydrating one book at a time', async () => {
  const rows = await db.all<never>('SELECT * FROM books ORDER BY id');
  const batched = await repo.hydrateAll(rows);
  const oneByOne = await Promise.all(rows.map((r) => repo.hydrateBook(r)));
  assert.deepEqual(batched, oneByOne);
});

test('ensureSearchIndexes reports honestly when it cannot help', async () => {
  // PGlite has no pg_trgm; the point is that it says so and carries on rather
  // than taking the server down.
  const lines: string[] = [];
  const ok = await ensureSearchIndexes((m: string) => lines.push(m));
  if (!ok) assert.match(lines.join(' '), /pg_trgm|could not build/);
  assert.equal((await repo.searchBooks('watch')).total, 2, 'search works either way');
});
