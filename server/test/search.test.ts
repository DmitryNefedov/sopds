import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Run against the in-process PostgreSQL (PGlite) unless told otherwise.
process.env.SOPDS_TEST_DB ??= 'mem';

const { default: db } = await import('../src/db/index.js');
const { initSchema, updateCounters, ensureSearchIndexes } = await import('../src/db/schema.js');
const repo = await import('../src/services/catalog.js');
const { loadSettings } = await import('../src/services/settings.js');
const { normalize } = await import('../src/utils/lang.js');

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

test('duplicate editions collapse before the page limit, not after', async () => {
  // Regression: the collapse used to run on the already-paged rows, so a
  // preview asking for N books could show far fewer and `total` counted
  // editions the caller never saw.
  const auth = (await db.get<{ id: number }>(
    'INSERT INTO authors (full_name, search_full_name, lang_code) VALUES (?, ?, 1) RETURNING id',
    ['Dupe Author', normalize('Dupe Author')],
  ))!.id;
  const mk = async (title: string, fmt: string) => {
    const id = (await db.get<{ id: number }>(
      `INSERT INTO books (filename, path, format, title, search_title, lang_code, avail)
       VALUES (?, 'r', ?, ?, ?, 1, 2) RETURNING id`,
      [`${title}-${fmt}`, fmt, title, normalize(title)],
    ))!.id;
    await db.run('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)', [id, auth]);
  };
  // Three distinct titles, each in three formats: 9 editions, 3 distinct books.
  for (const t of ['Zeta Alpha One', 'Zeta Alpha Two', 'Zeta Alpha Three'])
    for (const f of ['fb2', 'epub', 'mobi']) await mk(t, f);

  try {
    const first = await repo.searchBooks('zeta alpha', { page: 1, limit: 2 });
    assert.equal(first.total, 3, 'total counts distinct books, not editions');
    assert.equal(first.items.length, 2, 'a full page in spite of the collapsing');
    assert.equal(first.pages, 2);
    assert.ok(first.items.every((b) => b.doubles === 2), 'each carries its +2 duplicate count');

    const second = await repo.searchBooks('zeta alpha', { page: 2, limit: 2 });
    assert.equal(second.items.length, 1);
    const titles = new Set([...first.items, ...second.items].map((b) => b.title));
    assert.equal(titles.size, 3, 'the two pages cover every distinct book exactly once');
  } finally {
    await db.run('DELETE FROM book_authors WHERE author_id = ?', [auth]);
    await db.run("DELETE FROM books WHERE title LIKE 'Zeta Alpha %'");
    await db.run('DELETE FROM authors WHERE id = ?', [auth]);
  }
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

// ---- two-phase search --------------------------------------------------
// The UI runs the anchored pass and the substring pass at the same time and
// merges them, which only works if `prefix` results are always a subset of
// `all` results. These pin that relationship down.

test('prefix matches anchor at the start of a title', async () => {
  const anchored = await repo.searchBooks('night', { match: 'prefix' });
  assert.deepEqual(anchored.items.map((b) => b.title), ['Night Watch']);

  // "atch" is a substring of both titles but the start of nothing at all.
  const none = await repo.searchBooks('atch', { match: 'prefix' });
  assert.deepEqual(none.items.map((b) => b.title), [], 'nothing starts with "atch"');
  assert.equal(none.total, 0);
  assert.equal((await repo.searchBooks('atch')).total, 2, 'but the full pass finds both');
});

test('prefix matches also anchor on author and series names', async () => {
  // The query need only prefix one of the three sides. Neither title starts
  // with "lukyanenko" or "watch" — the author and the series do.
  const byAuthor = await repo.searchBooks('lukyanenko', { match: 'prefix' });
  assert.deepEqual(byAuthor.items.map((b) => b.title), ['Day Watch', 'Night Watch']);

  const bySeries = await repo.searchBooks('watch', { match: 'prefix' });
  assert.deepEqual(bySeries.items.map((b) => b.title), ['Day Watch', 'Night Watch']);

  // …while a mid-name substring reaches them only through the full pass.
  assert.equal((await repo.searchBooks('yanenko', { match: 'prefix' })).total, 0);
  assert.equal((await repo.searchBooks('yanenko')).total, 2);
});

test('an exact query is included in its own prefix results', async () => {
  const exact = await repo.searchBooks('night watch', { match: 'prefix' });
  assert.deepEqual(exact.items.map((b) => b.title), ['Night Watch']);
});

test('every prefix result is also a full result, for all three types', async () => {
  for (const q of ['night', 'day', 'lukyanenko', 'war', 'to']) {
    const [fastBooks, allBooks] = await Promise.all([
      repo.searchBooks(q, { match: 'prefix', limit: 200 }),
      repo.searchBooks(q, { match: 'all', limit: 200 }),
    ]);
    const full = new Set(allBooks.items.map((b) => b.id));
    for (const b of fastBooks.items) {
      assert.ok(full.has(b.id), `"${q}": book ${b.title} is in the full result too`);
    }
    assert.ok(fastBooks.total <= allBooks.total, `"${q}": prefix total <= full total`);

    const [fastAuthors, allAuthors] = await Promise.all([
      repo.searchAuthors(q, { match: 'prefix', limit: 200 }),
      repo.searchAuthors(q, { match: 'all', limit: 200 }),
    ]);
    const authorIds = new Set(allAuthors.items.map((a) => a.id));
    for (const a of fastAuthors.items) assert.ok(authorIds.has(a.id), `"${q}": ${a.full_name}`);

    const [fastSeries, allSeries] = await Promise.all([
      repo.searchSeries(q, { match: 'prefix', limit: 200 }),
      repo.searchSeries(q, { match: 'all', limit: 200 }),
    ]);
    const serIds = new Set(allSeries.items.map((s) => s.id));
    for (const s of fastSeries.items) assert.ok(serIds.has(s.id), `"${q}": ${s.ser}`);
  }
});

test('the default match is the full substring search', async () => {
  const explicit = await repo.searchBooks('watch', { match: 'all' });
  const implied = await repo.searchBooks('watch');
  assert.equal(implied.total, explicit.total);
  assert.equal(implied.total, 2);
});

test('authors and series honour the prefix mode too', async () => {
  assert.deepEqual(
    (await repo.searchAuthors('luk', { match: 'prefix' })).items.map((a) => a.full_name),
    ['Lukyanenko Sergey'],
  );
  // "sergey" is the second word of the name, so it is not a prefix of it.
  assert.deepEqual((await repo.searchAuthors('sergey', { match: 'prefix' })).items, []);
  assert.equal((await repo.searchAuthors('sergey', { match: 'all' })).total, 1);

  assert.deepEqual(
    (await repo.searchSeries('wat', { match: 'prefix' })).items.map((s) => s.ser),
    ['Watch'],
  );
});

test('LIKE wildcards in a query are matched literally, not as wildcards', async () => {
  // Without escaping, "%" alone would match every row in the catalog — the
  // worst possible query to hand an unindexed LIKE.
  assert.equal((await repo.searchBooks('%')).total, 0);
  assert.equal((await repo.searchAuthors('%')).total, 0);
  assert.equal((await repo.searchSeries('%')).total, 0);
  // "_" is LIKE's single-character wildcard; "N_ght Watch" must not match.
  assert.equal((await repo.searchBooks('N_ght Watch')).total, 0);
  assert.equal((await repo.searchBooks('Night Watch')).total, 1);
});

test('searchAll can run either half, and both keep the three types together', async () => {
  const full = await repo.searchAll('watch');
  assert.equal(full.books.total, 2);
  assert.equal(full.series.total, 1);

  const fast = await repo.searchAll('watch', { match: 'prefix' });
  assert.equal(fast.series.total, 1, 'the series is named "Watch"');
  assert.equal(fast.books.total, 2, 'and its books match through it');

  // A mid-word query is reachable only by the full pass, which is the case the
  // two-phase UI exists for: the fast half comes back empty, then fills in.
  const nothing = await repo.searchAll('atch', { match: 'prefix' });
  assert.equal(nothing.books.total, 0);
  assert.equal(nothing.series.total, 0);
  assert.equal((await repo.searchAll('atch')).books.total, 2);
});

test('the quick pass reports what it found, flagged as not a count', async () => {
  const quick = await repo.searchBooks('night', { match: 'prefix', limit: 1 });
  assert.equal(quick.partial, true, 'total is a floor, not a count');
  assert.equal(quick.items.length, 1);
  assert.equal(quick.total, 1);
  assert.equal(quick.has_next, false, 'a partial page never offers a next page');
  assert.equal(quick.pages, 1);

  // The full pass counts properly and says nothing about being partial.
  const full = await repo.searchBooks('watch', { limit: 1 });
  assert.equal(full.partial, undefined);
  assert.equal(full.total, 2);
  assert.equal(full.has_next, true);
});

test('the quick pass ignores paging and always answers the first page', async () => {
  // It exists to fill the screen fast; offsets belong to the counted pass.
  const p2 = await repo.searchBooks('watch', { match: 'prefix', page: 2, limit: 1 });
  assert.equal(p2.page, 1);
  assert.deepEqual(
    p2.items.map((b) => b.id),
    (await repo.searchBooks('watch', { match: 'prefix', page: 1, limit: 1 })).items.map((b) => b.id),
  );
});
