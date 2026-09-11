import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// The browse half of the catalog service: alphabetic listings, the four
// "books by X" queries, the directory tree and the stats counters. Search has
// its own file; nothing here goes through LIKE '%…%'.

process.env.SOPDS_TEST_DB ??= 'mem';

const { default: db } = await import('../src/db/index.js');
const { initSchema, updateCounters } = await import('../src/db/schema.js');
const repo = await import('../src/services/catalog.js');
const { loadSettings, setMany, getState, setState } = await import('../src/services/settings.js');
const { normalize } = await import('../src/utils/lang.js');

const TABLES = [
  'book_authors', 'book_series', 'book_genres',
  'books', 'authors', 'series', 'catalogs', 'counters',
];

const ids = {
  root: 0, sub: 0,
  alpha: 0, beta: 0, gamma: 0, hidden: 0,
  author: 0, series: 0, genre: 0,
};

before(async () => {
  await initSchema();
  await loadSettings();
  await setMany({ maxItems: 50, doublesHide: false });
  await db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);

  const catalog = async (name: string, path: string, parent: number | null) =>
    (await db.get<{ id: number }>(
      `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size)
       VALUES (?, ?, ?, 0, 0) RETURNING id`,
      [parent, name, path],
    ))!.id;
  ids.root = await catalog('.', '.', null);
  ids.sub = await catalog('russian', 'russian', ids.root);

  const book = async (title: string, catalogId: number, avail = 2, langCode = 2) =>
    (await db.get<{ id: number }>(
      `INSERT INTO books (filename, path, format, title, search_title, lang_code, catalog_id, avail)
       VALUES (?, 'r', 'fb2', ?, ?, ?, ?, ?) RETURNING id`,
      [`${title}.fb2`, title, normalize(title), langCode, catalogId, avail],
    ))!.id;
  ids.alpha = await book('Alpha', ids.root);
  ids.beta = await book('Beta', ids.sub);
  ids.gamma = await book('Gamma', ids.sub, 2, 1);
  ids.hidden = await book('Alpha Unavailable', ids.root, 0);
  // The withdrawn edition doubles as the fixture for annotation + zip locators:
  // it never shows up in a listing, so loading it does not perturb any count.
  await db.run(
    `UPDATE books SET annotation = ?, zip_offset = 512, zip_csize = 128, zip_method = 8
     WHERE id = ?`,
    ['<p>An <b>annotated</b> book</p>', ids.hidden],
  );

  ids.author = (await db.get<{ id: number }>(
    'INSERT INTO authors (full_name, search_full_name, lang_code) VALUES (?, ?, 2) RETURNING id',
    ['Adams Douglas', normalize('Adams Douglas')],
  ))!.id;
  ids.series = (await db.get<{ id: number }>(
    'INSERT INTO series (ser, search_ser, lang_code) VALUES (?, ?, 2) RETURNING id',
    ['Hitchhiker', normalize('Hitchhiker')],
  ))!.id;
  ids.genre = (await db.get<{ id: number }>(
    "INSERT INTO genres (genre, section, subsection) VALUES ('sf_test', 'Fiction', 'Science fiction') RETURNING id",
  ))!.id;

  for (const b of [ids.alpha, ids.beta, ids.hidden]) {
    await db.run('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)', [b, ids.author]);
    await db.run('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)', [b, ids.genre]);
  }
  await db.run('INSERT INTO book_series (book_id, ser_id, ser_no) VALUES (?, ?, 2)', [
    ids.alpha,
    ids.series,
  ]);
  await db.run('INSERT INTO book_series (book_id, ser_id, ser_no) VALUES (?, ?, 1)', [
    ids.beta,
    ids.series,
  ]);
  await updateCounters();
});

after(async () => {
  await db.end();
});

test('getBook hydrates authors, genres and series', async () => {
  const book = await repo.getBook(ids.alpha);
  assert.equal(book!.title, 'Alpha');
  assert.deepEqual(book!.authors.map((a) => a.full_name), ['Adams Douglas']);
  assert.deepEqual(book!.genres.map((g) => g.subsection), ['Science fiction']);
  assert.deepEqual(book!.series.map((s) => s.ser), ['Hitchhiker']);
});

test('getBook returns null for an id that is not there', async () => {
  assert.equal(await repo.getBook(999_999), null);
});

test('getBook strips tags from the annotation and passes the zip locators through', async () => {
  const zipped = await repo.getBook(ids.hidden);
  assert.equal(zipped!.annotation, 'An annotated book', 'markup removed, text kept');
  assert.deepEqual(
    { o: zipped!.zip_offset, c: zipped!.zip_csize, m: zipped!.zip_method },
    { o: 512, c: 128, m: 8 },
  );

  const loose = await repo.getBook(ids.alpha);
  assert.equal(loose!.annotation, '', 'an empty annotation stays an empty string');
  assert.equal(loose!.zip_offset, null, 'a book outside a zip reports null, not undefined');
  assert.equal(loose!.zip_csize, null);
  assert.equal(loose!.zip_method, null);
});

test('getBookRef returns only what locating the bytes needs', async () => {
  const ref = await repo.getBookRef(ids.alpha);
  assert.deepEqual(Object.keys(ref!).sort(), [
    'cat_type', 'filename', 'path', 'zip_csize', 'zip_method', 'zip_offset',
  ]);
});

test('books by author, series and genre exclude unavailable books', async () => {
  const byAuthor = await repo.booksByAuthor(ids.author);
  assert.deepEqual(byAuthor.items.map((b) => b.title), ['Alpha', 'Beta']);

  const byGenre = await repo.booksByGenre(ids.genre);
  assert.deepEqual(byGenre.items.map((b) => b.title), ['Alpha', 'Beta']);

  const bySeries = await repo.booksBySeries(ids.series);
  assert.deepEqual(bySeries.items.map((b) => b.title), ['Beta', 'Alpha'], 'ordered by ser_no');
});

test('total counts the books a caller can actually reach, not the join rows', async () => {
  // `ids.hidden` is linked to the same author and genre but is unavailable, so
  // counting the join table would promise a page of results that is not there.
  const byAuthor = await repo.booksByAuthor(ids.author);
  assert.equal(byAuthor.total, byAuthor.items.length);
  const byGenre = await repo.booksByGenre(ids.genre);
  assert.equal(byGenre.total, byGenre.items.length);

  // The last page must not claim there is another one behind it.
  const page = await repo.booksByAuthor(ids.author, { page: 1, limit: 2 });
  assert.equal(page.has_next, false);
  assert.equal(page.pages, 1);
});

test('a listing pages, and the page meta agrees with the rows', async () => {
  const first = await repo.booksByAuthor(ids.author, { page: 1, limit: 1 });
  assert.equal(first.items.length, 1);
  assert.deepEqual(
    { page: first.page, limit: first.limit, has_prev: first.has_prev, has_next: first.has_next },
    { page: 1, limit: 1, has_prev: false, has_next: true },
  );
  const last = await repo.booksByAuthor(ids.author, { page: first.pages, limit: 1 });
  assert.equal(last.has_next, false);
  assert.equal(last.has_prev, true);
});

test('a bad page or limit falls back to page 1 and the configured default', async () => {
  const page = await repo.listBooks({ page: 'nonsense', limit: '-3' });
  assert.equal(page.page, 1);
  assert.equal(page.limit, 50);
});

test('limit is capped so a caller cannot ask for the whole catalog', async () => {
  const page = await repo.listBooks({ limit: 10_000 });
  assert.equal(page.limit, 200);
});

test('an unfiltered listing returns every available row (no prefix, no lang filter)', async () => {
  const all = await repo.listBooks();
  assert.deepEqual(all.items.map((b) => b.title).sort(), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(all.total, 3);
  const same = await repo.listBooks({ prefix: '', langCode: 0 });
  assert.equal(same.total, 3);
  assert.equal((await repo.listAuthors()).total, 1);
  assert.equal((await repo.listSeries()).total, 1);
});

test('listings filter by prefix and by language group', async () => {
  const prefixed = await repo.listBooks({ prefix: 'al' });
  assert.deepEqual(prefixed.items.map((b) => b.title), ['Alpha']);
  assert.deepEqual(
    prefixed.items[0].authors.map((a) => a.full_name),
    ['Adams Douglas'],
    'listBooks rows are hydrated, not raw',
  );

  const cyrillic = await repo.listBooks({ langCode: 1 });
  assert.deepEqual(cyrillic.items.map((b) => b.title), ['Gamma']);
  assert.equal((await repo.listBooks({ langCode: 2 })).total, 2, 'Latin group');

  const authors = await repo.listAuthors({ prefix: 'ad' });
  assert.equal(authors.items[0].book_count, 3);
  assert.deepEqual((await repo.listAuthors({ prefix: 'zz' })).items, []);

  const series = await repo.listSeries({ prefix: 'hit' });
  assert.equal(series.items[0].ser, 'Hitchhiker');
  assert.equal(series.items[0].book_count, 2);
});

test('browse starts at the synthetic "." root and walks into children', async () => {
  assert.equal(await repo.rootCatalogId(), ids.root);

  const children = await repo.childCatalogs(ids.root);
  assert.deepEqual(children.map((c) => [c.cat_name, c.book_count]), [['russian', 2]]);

  const rootBooks = await repo.booksByCatalog(ids.root);
  assert.deepEqual(rootBooks.items.map((b) => b.title), ['Alpha']);
  const subBooks = await repo.booksByCatalog(ids.sub);
  assert.deepEqual(subBooks.items.map((b) => b.title), ['Beta', 'Gamma']);
});

test('a null catalog / parent id selects the "no catalog" and top-level rows', async () => {
  // Every fixture book has a catalog, so catalog_id IS NULL matches nothing.
  const orphans = await repo.booksByCatalog(null);
  assert.deepEqual(orphans.items, []);
  assert.equal(orphans.total, 0);

  // parent_id IS NULL is the synthetic "." root itself.
  const top = await repo.childCatalogs(null);
  assert.deepEqual(top.map((c) => c.cat_name), ['.']);
});

test('booksByCatalog(null) still applies the page limit to the "no catalog" rows', async () => {
  // Two books with no catalog at all, cleaned up after so no other count moves.
  const mk = (t: string) =>
    db.run(
      `INSERT INTO books (filename, path, format, title, search_title, lang_code, catalog_id, avail)
       VALUES (?, 'r', 'fb2', ?, ?, 2, NULL, 2)`,
      [`${t}.fb2`, t, normalize(t)],
    );
  await mk('Orphan One');
  await mk('Orphan Two');
  try {
    const p1 = await repo.booksByCatalog(null, { page: 1, limit: 1 });
    assert.equal(p1.items.length, 1, 'the limit reaches the null-catalog branch');
    assert.equal(p1.total, 2);
    assert.equal(p1.has_next, true);
    const p2 = await repo.booksByCatalog(null, { page: 2, limit: 1 });
    assert.notEqual(p2.items[0].id, p1.items[0].id);
  } finally {
    await db.run("DELETE FROM books WHERE title LIKE 'Orphan %'");
  }
});

test('booksByCatalog pages, and the count agrees with the rows', async () => {
  const p1 = await repo.booksByCatalog(ids.sub, { page: 1, limit: 1 });
  assert.equal(p1.items.length, 1);
  assert.equal(p1.total, 2);
  assert.equal(p1.has_next, true);
  const p2 = await repo.booksByCatalog(ids.sub, { page: 2, limit: 1 });
  assert.equal(p2.items.length, 1);
  assert.equal(p2.has_prev, true);
  assert.notEqual(p1.items[0].id, p2.items[0].id);
});

test('breadcrumbs omit the synthetic root and read parent-first', async () => {
  assert.deepEqual(await repo.catalogBreadcrumbs(ids.root), []);
  assert.deepEqual(await repo.catalogBreadcrumbs(ids.sub), [{ id: ids.sub, name: 'russian' }]);
  assert.deepEqual(await repo.catalogBreadcrumbs(null), []);
});

test('genre sections list only genres that have books', async () => {
  const sections = await repo.genreSections();
  assert.deepEqual(sections.map((s) => s.section), ['Fiction']);
  assert.equal(sections[0].book_count, 3);

  const inSection = await repo.genresInSection(sections[0].section_id);
  assert.deepEqual(inSection.map((g) => g.subsection), ['Science fiction']);
  assert.deepEqual(await repo.genresInSection(999_999), []);
});

test('stats reports the counters the last updateCounters wrote', async () => {
  const s = await repo.stats();
  assert.equal(s.allbooks, 4);
  assert.equal(s.allcatalogs, 2);
  assert.equal(s.allauthors, 1);
  assert.equal(s.allseries, 1);
  assert.ok(s.lastscan, 'lastscan is stamped');
});

test('randomBook returns a hydrated book', async () => {
  const book = await repo.randomBook();
  assert.ok(book && typeof book.title === 'string');
  assert.ok(Array.isArray(book.authors));
});

// randomBook used to be `ORDER BY random() LIMIT 1`, a full-table sort with no
// index to help it, and no `avail` filter at all. These pin down its
// replacement: an index-backed pick that never surfaces an unavailable book,
// served from a cache that a request only ever misses once.

test('randomBook never returns a book that has become unavailable', async () => {
  for (let i = 0; i < 20; i++) {
    const book = await repo.randomBook();
    assert.notEqual(book!.id, ids.hidden, 'the withdrawn edition is never picked');
  }
});

test('pickRandomBookId only ever lands on an available row', async () => {
  const available = new Set([ids.alpha, ids.beta, ids.gamma]);
  for (let i = 0; i < 30; i++) {
    const id = await repo.pickRandomBookId();
    assert.ok(id != null && available.has(id), `picked ${id}, expected one of the available ids`);
  }
});

test('pickRandomBookId maps the random point linearly across the id range', async () => {
  const real = Math.random;
  // ids.alpha/beta/gamma are the three consecutive available ids 1,2,3.
  const [lo, mid, hi] = [ids.alpha, ids.beta, ids.gamma].sort((a, b) => a - b);
  try {
    Math.random = () => 0; //          point == lo
    assert.equal(await repo.pickRandomBookId(), lo);
    Math.random = () => 0.5; //         point == lo + floor(0.5 * 3) == lo + 1 == mid
    assert.equal(await repo.pickRandomBookId(), mid, 'the middle of the range picks the middle id');
    Math.random = () => 0.999999; //    point == hi
    assert.equal(await repo.pickRandomBookId(), hi);
  } finally {
    Math.random = real;
  }
});

test('pickRandomBookId returns null when there are no available books', async () => {
  await db.run('UPDATE books SET avail = 0');
  try {
    assert.equal(await repo.pickRandomBookId(), null);
  } finally {
    await db.run('UPDATE books SET avail = 2 WHERE title <> ?', ['Alpha Unavailable']);
  }
});

test('randomBook serves the cached id directly, with no picking involved', async () => {
  await setState('randomBookId', ids.beta);
  const real = Math.random;
  try {
    // A fresh pick would land on the lowest id (Alpha), never Beta - so if the
    // returned book is Beta, the cache was used and nothing was picked.
    Math.random = () => 0;
    const book = await repo.randomBook();
    assert.equal(book!.id, ids.beta);
  } finally {
    Math.random = real;
  }
});

test('randomBook recovers when the cached id no longer resolves to a book', async () => {
  await setState('randomBookId', 999_999);
  const book = await repo.randomBook();
  assert.ok(book, 'a fresh pick stands in for the stale one');
  assert.notEqual(book!.id, 999_999);
});

test('refreshRandomBookId leaves a fresh, available id behind for the next call', async () => {
  await setState('randomBookId', null);
  await repo.refreshRandomBookId();
  const cached = getState<number>('randomBookId');
  assert.ok(cached != null, 'a real request never awaits this, but it does eventually land');
  assert.ok([ids.alpha, ids.beta, ids.gamma].includes(cached!));
});

test('refreshRandomBookId leaves the cache untouched when there is nothing to pick', async () => {
  await db.run('UPDATE books SET avail = 0');
  await setState('randomBookId', ids.beta);
  try {
    await repo.refreshRandomBookId();
    assert.equal(
      getState<number>('randomBookId'),
      ids.beta,
      'a pick that found nothing must not overwrite the id with null',
    );
  } finally {
    await db.run('UPDATE books SET avail = 2 WHERE title <> ?', ['Alpha Unavailable']);
  }
});
