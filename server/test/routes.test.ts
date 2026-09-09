import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// The HTTP surface, over a real listening server: the JSON API, the OPDS feed
// and the admin endpoints. A scan of a real (tiny) collection sets it up, so
// downloads and covers serve actual bytes rather than fixtures.

process.env.SOPDS_TEST_DB ??= 'mem';
process.env.SOPDS_LOG_REQUESTS = '0';
process.env.SOPDS_EBOOK_CONVERT = ''; // built-in converters only, never Calibre

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-routes-'));
const lib = path.join(tmp, 'books');
fs.mkdirSync(path.join(lib, 'shelf'), { recursive: true });
process.env.SOPDS_ROOT_LIB = lib;

const { default: db } = await import('../src/db/index.js');
const { initSchema } = await import('../src/db/schema.js');
const settings = await import('../src/services/settings.js');
const { runOnce } = await import('../src/services/scanner/engine.js');
const { createApp } = await import('../src/app.js');
const repo = await import('../src/services/catalog.js');
const { default: config } = await import('../src/config/index.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const fb2 = (title: string, author: string, opts: { cover?: boolean } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info>
<genre>sf</genre>
<author><first-name>${author.split(' ')[1]}</first-name><last-name>${author.split(' ')[0]}</last-name></author>
<book-title>${title}</book-title>
<annotation><p>About ${title}.</p></annotation>
<lang>en</lang>
<sequence name="Test Series" number="1"/>
${opts.cover ? '<coverpage><image l:href="#cover.png"/></coverpage>' : ''}
</title-info></description>
<body><section><title><p>${title}</p></title><p>Body of ${title}.</p></section></body>
${opts.cover ? `<binary id="cover.png" content-type="image/png">${PNG.toString('base64')}</binary>` : ''}
</FictionBook>`;

let server: Server;
let base = '';

const get = (p: string, init?: RequestInit) => fetch(`${base}${p}`, init);
const json = async (p: string, init?: RequestInit) => {
  const res = await get(p, init);
  return { status: res.status, body: (await res.json()) as any };
};

let bookId = 0;
let coverBookId = 0;

before(async () => {
  fs.writeFileSync(path.join(lib, 'shelf', 'alpha.fb2'), fb2('Alpha Story', 'Adams Douglas'));
  fs.writeFileSync(
    path.join(lib, 'shelf', 'beta.fb2'),
    fb2('Beta Story', 'Adams Douglas', { cover: true }),
  );
  fs.writeFileSync(path.join(lib, 'notes.txt'), 'not a book');

  await initSchema();
  await settings.loadSettings();
  await settings.setMany({ maxItems: 50, doublesHide: false, titleAsFilename: true });
  await db.exec(
    'TRUNCATE book_authors, book_series, book_genres, books, authors, series, catalogs, counters RESTART IDENTITY CASCADE',
  );
  await runOnce({ log: () => {} });

  bookId = (await db.get<{ id: number }>(
    "SELECT id FROM books WHERE title = 'Alpha Story'",
  ))!.id;
  coverBookId = (await db.get<{ id: number }>(
    "SELECT id FROM books WHERE title = 'Beta Story'",
  ))!.id;

  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- health ------------------------------------------------------------

test('with SOPDS_LOG_REQUESTS=0 the verbose request logger stays silent', async () => {
  const real = console.log;
  let buf = '';
  console.log = (...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  };
  try {
    // a browser-style navigation - would trigger the verbose block if VERBOSE were on
    await (await get('/', { headers: { accept: 'text/html' } })).text().catch(() => '');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    console.log = real;
  }
  assert.doesNotMatch(buf, /UI request/);
});

test('/health reports the database is reachable', async () => {
  for (const p of ['/health', '/healthz']) {
    const { status, body } = await json(p);
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
  }
});

// ---- search ------------------------------------------------------------

test('GET /api/search with no query returns an empty result, not an error', async () => {
  const { status, body } = await json('/api/search');
  assert.equal(status, 200);
  assert.deepEqual(body, { query: '', type: 'all', match: 'all', results: null });
});

test('GET /api/search returns a preview of every type by default', async () => {
  const { body } = await json('/api/search?q=story');
  assert.equal(body.type, 'all');
  assert.equal(body.results.books.total, 2, 'both titles contain "story"');
  assert.equal(body.results.authors.total, 0);
  assert.equal(body.results.series.total, 0);
});

test('GET /api/search narrows to one type on demand', async () => {
  const books = await json('/api/search?q=alpha&type=books');
  assert.deepEqual(books.body.results.items.map((b: any) => b.title), ['Alpha Story']);

  const authors = await json('/api/search?q=adams&type=authors');
  assert.equal(authors.body.results.items[0].full_name, 'Adams Douglas');

  const series = await json('/api/search?q=test&type=series');
  assert.equal(series.body.results.items[0].ser, 'Test Series');
});

test('GET /api/search?match=exact runs the fast half on its own', async () => {
  // Both books are titled "<something> Story", so "story" is a substring of
  // each but neither book's title equals it.
  const fast = await json('/api/search?q=story&type=books&match=exact');
  assert.equal(fast.body.match, 'exact');
  assert.equal(fast.body.results.total, 0);

  // The whole title, on the other hand, is an exact hit.
  const hit = await json('/api/search?q=alpha+story&type=books&match=exact');
  assert.equal(hit.body.results.total, 1);
  assert.equal(hit.body.results.items[0].title, 'Alpha Story');

  const full = await json('/api/search?q=story&type=books');
  assert.equal(full.body.match, 'all', 'the full substring pass is the default');
  assert.equal(full.body.results.total, 2);
});

test('the fast half of a search is a subset of the full one', async () => {
  // What the UI relies on: it paints the exact pass, then merges the full
  // pass into it, and nothing it already showed may vanish.
  const [fast, full] = await Promise.all([
    json('/api/search?q=alpha+story&type=books&match=exact&limit=50'),
    json('/api/search?q=alpha&type=books&limit=50'),
  ]);
  const fullIds = new Set(full.body.results.items.map((b: any) => b.id));
  assert.ok(fast.body.results.items.length > 0, 'the exact pass found something');
  for (const b of fast.body.results.items) assert.ok(fullIds.has(b.id), `${b.title} is in both`);
});

test('match applies to authors, series and the combined overview alike', async () => {
  assert.equal((await json('/api/search?q=adams+douglas&type=authors&match=exact')).body.results.total, 1);
  assert.equal((await json('/api/search?q=douglas&type=authors&match=exact')).body.results.total, 0);
  assert.equal((await json('/api/search?q=douglas&type=authors')).body.results.total, 1);

  assert.equal((await json('/api/search?q=test+series&type=series&match=exact')).body.results.total, 1);
  assert.equal((await json('/api/search?q=series&type=series&match=exact')).body.results.total, 0);

  const overview = await json('/api/search?q=alpha+story&match=exact');
  assert.equal(overview.body.type, 'all');
  assert.equal(overview.body.results.books.total, 1);
});

test('an unknown match value falls back to the full search', async () => {
  const res = await json('/api/search?q=story&type=books&match=nonsense');
  assert.equal(res.body.match, 'all');
  assert.equal(res.body.results.total, 2);
});

test('a query of LIKE wildcards matches nothing rather than everything', async () => {
  assert.equal((await json('/api/search?q=%25&type=books')).body.results.total, 0);
  assert.equal((await json('/api/search?q=_&type=books')).body.results.total, 0);
});

// ---- books -------------------------------------------------------------

test('GET /api/books lists the scanned collection', async () => {
  const { body } = await json('/api/books');
  assert.equal(body.total, 2);
  assert.deepEqual(body.items.map((b: any) => b.title), ['Alpha Story', 'Beta Story']);
  assert.equal(body.items[0].authors[0].full_name, 'Adams Douglas');
});

test('GET /api/books/:id offers every download format, marking the native one', async () => {
  const { body } = await json(`/api/books/${bookId}`);
  assert.equal(body.title, 'Alpha Story');
  assert.equal(body.annotation, 'About Alpha Story.', 'markup is stripped');
  const formats = body.download_formats.map((f: any) => f.format).sort();
  assert.deepEqual(formats, ['epub', 'fb2', 'mobi']);
  assert.ok(body.download_formats.find((f: any) => f.format === 'fb2').native);
});

test('GET /api/books/:id is a 404 for an unknown id', async () => {
  const { status, body } = await json('/api/books/999999');
  assert.equal(status, 404);
  assert.equal(body.error, 'not found');
});

test('a native download serves the file bytes under a translitterated name', async () => {
  const res = await get(`/api/books/${bookId}/download`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/fb2+xml');
  assert.match(res.headers.get('content-disposition')!, /filename="alpha_story\.fb2"/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.includes('<book-title>Alpha Story</book-title>'));
});

test('a download converts to the requested format', async () => {
  const res = await get(`/api/books/${bookId}/download?format=epub`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/epub+zip');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.toString('latin1', 0, 2), 'PK', 'an epub is a zip');
  assert.ok(body.includes('mimetype'));
});

test('a download can be wrapped in a zip', async () => {
  const res = await get(`/api/books/${bookId}/download?zip=1`);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition')!, /filename="alpha_story\.fb2\.zip"/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('latin1', 0, 2), 'PK');
});

test('an unsupported target format is refused, not silently served', async () => {
  const { status, body } = await json(`/api/books/${bookId}/download?format=djvu`);
  assert.equal(status, 400);
  assert.match(body.error, /Cannot convert to \.djvu/);
});

test('a download whose file has vanished is a 404', async () => {
  const missing = (await db.get<{ id: number }>(
    `INSERT INTO books (filename, path, format, title, search_title, avail)
     VALUES ('gone.fb2', 'shelf', 'fb2', 'Gone', 'GONE', 2) RETURNING id`,
  ))!.id;
  const { status, body } = await json(`/api/books/${missing}/download`);
  assert.equal(status, 404);
  assert.equal(body.error, 'file missing');
  await db.run('DELETE FROM books WHERE id = ?', [missing]);
});

test('a cover is served from the book, and the placeholder stands in otherwise', async () => {
  const withCover = await get(`/api/books/${coverBookId}/cover`);
  assert.equal(withCover.status, 200);
  assert.equal(withCover.headers.get('content-type'), 'image/png');
  assert.equal(withCover.headers.get('x-cover'), null);
  assert.deepEqual(Buffer.from(await withCover.arrayBuffer()), PNG);

  const without = await get(`/api/books/${bookId}/cover`);
  assert.equal(without.status, 200);
  assert.equal(without.headers.get('x-cover'), 'default');
  assert.match(without.headers.get('cache-control')!, /max-age=86400/);

  assert.equal((await get('/api/books/999999/cover')).status, 404);
});

// ---- authors, series, genres, catalogs ---------------------------------

test('GET /api/authors lists authors with their book counts', async () => {
  const { body } = await json('/api/authors');
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].book_count, 2);

  const books = await json(`/api/authors/${body.items[0].id}/books`);
  assert.equal(books.body.total, 2);
});

test('GET /api/series lists series and their books', async () => {
  const { body } = await json('/api/series');
  assert.equal(body.items[0].ser, 'Test Series');
  const books = await json(`/api/series/${body.items[0].id}/books`);
  assert.deepEqual(books.body.items.map((b: any) => b.title), ['Alpha Story', 'Beta Story']);
});

test('GET /api/genres walks sections then genres then books', async () => {
  const sections = await json('/api/genres');
  assert.ok(sections.body.length > 0);
  const genres = await json(`/api/genres?section=${sections.body[0].section_id}`);
  assert.ok(genres.body.length > 0);
  const books = await json(`/api/genres/${genres.body[0].id}/books`);
  assert.equal(books.body.total, 2);
});

test('GET /api/catalogs returns breadcrumbs, children and books', async () => {
  const root = await json('/api/catalogs');
  assert.deepEqual(root.body.breadcrumbs, []);
  assert.deepEqual(root.body.catalogs.map((c: any) => c.cat_name), ['shelf']);
  assert.equal(root.body.books.total, 0, 'no loose books at the collection root');

  const shelf = await json(`/api/catalogs?cat=${root.body.catalogs[0].id}`);
  assert.deepEqual(shelf.body.breadcrumbs.map((b: any) => b.name), ['shelf']);
  assert.equal(shelf.body.books.total, 2);
});

// ---- meta --------------------------------------------------------------

test('GET /api/stats carries the counters and the catalog title', async () => {
  const { body } = await json('/api/stats');
  assert.equal(body.allbooks, 2);
  assert.equal(body.title, settings.S.title);
  assert.equal(body.lang_menu['1'], 'Cyrillic');
});

test('GET /api/random returns a book, and /api/convert-info the engine', async () => {
  const random = await json('/api/random');
  assert.ok(random.body.title);
  const info = await json('/api/convert-info');
  assert.deepEqual(info.body.formats, ['fb2', 'epub', 'mobi']);
  assert.equal(info.body.engine, 'builtin');
});

// ---- admin -------------------------------------------------------------

test('GET /api/admin/settings exposes grouped definitions and current values', async () => {
  const { body } = await json('/api/admin/settings');
  assert.equal(body.auth, false);
  assert.deepEqual(
    body.groups.map((g: any) => g.group),
    ['General', 'Scanning', 'Display', 'Conversion'],
  );
  assert.equal(body.values.rootLib, lib);

  // each group carries exactly its own settings, fully described
  const flat: Record<string, any> = {};
  for (const g of body.groups) for (const s of g.settings) flat[s.key] = { ...s, group: g.group };
  assert.equal(flat.title.group, 'General');
  assert.equal(flat.maxItems.group, 'Display');
  assert.ok(!('scanCron' in flat && flat.scanCron.group !== 'Scanning'), 'no setting leaks between groups');

  // help is the string when present, null when absent
  assert.equal(flat.rootLib.help, 'Absolute path to the folder that holds your books');
  assert.equal(flat.title.help, null);
  // min/max are the numbers for a bounded int, null otherwise
  assert.deepEqual([flat.maxItems.min, flat.maxItems.max], [1, 200]);
  assert.deepEqual([flat.title.min, flat.title.max], [null, null]);
  // the rest of the descriptor
  assert.deepEqual(
    { key: flat.maxItems.key, label: flat.maxItems.label, type: flat.maxItems.type },
    { key: 'maxItems', label: 'Items per page', type: 'int' },
  );
  assert.equal(typeof flat.maxItems.default, 'number');
  assert.ok(body.converter && Array.isArray(body.converter.formats));
});

test('an admin request still succeeds when a stray token header is sent but none is configured', async () => {
  const res = await get('/api/admin/settings', { headers: { 'x-admin-token': 'irrelevant' } });
  assert.equal(res.status, 200, 'with no SOPDS_ADMIN_TOKEN the guard is off entirely');
});

test('POST /api/admin/scan kicks off a scan and reports started/queued', async () => {
  const { status, body } = await json('/api/admin/scan', { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(typeof body.started, 'boolean');
  assert.equal(typeof body.queued, 'boolean');
  assert.ok(body.started || body.queued, 'the trigger either started a run or queued one');
});

test('PUT /api/admin/settings persists a change and reports it back', async () => {
  const { status, body } = await json('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subtitle: 'Changed by test' }),
  });
  assert.equal(status, 200);
  assert.equal(body.values.subtitle, 'Changed by test');
  assert.equal(settings.S.subtitle, 'Changed by test');
});

test('PUT /api/admin/settings rejects a bad value with per-field errors', async () => {
  const { status, body } = await json('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCron: 'not a cron' }),
  });
  assert.equal(status, 400);
  assert.match(body.fields.scanCron, /invalid cron/);
});

test('GET /api/admin/check-path validates the collection directory', async () => {
  const ok = await json(`/api/admin/check-path?path=${encodeURIComponent(lib)}`);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.entries, 2);

  const missing = await json('/api/admin/check-path?path=/no/such/place');
  assert.deepEqual(missing.body, { ok: false, reason: 'does not exist' });

  const file = await json(
    `/api/admin/check-path?path=${encodeURIComponent(path.join(lib, 'notes.txt'))}`,
  );
  assert.deepEqual(file.body, { ok: false, reason: 'not a directory' });

  // a non-ENOENT stat error surfaces its own message, not "does not exist"
  const notdir = await json(
    `/api/admin/check-path?path=${encodeURIComponent(path.join(lib, 'notes.txt', 'nested'))}`,
  );
  assert.equal(notdir.body.ok, false);
  assert.notEqual(notdir.body.reason, 'does not exist');
  assert.match(notdir.body.reason, /ENOTDIR|not a directory/i);
});

test('GET /api/admin/scan reports scanner state, and /api/admin/info the runtime', async () => {
  const scan = await json('/api/admin/scan');
  assert.equal(scan.body.running, false);
  assert.equal(typeof scan.body.cron, 'string');
  assert.equal(typeof scan.body.watch.watching, 'boolean');

  const info = await json('/api/admin/info');
  assert.equal(info.body.node, process.version);
  assert.equal(typeof info.body.database, 'string');
  assert.ok(info.body.database.length > 0);
  // in-memory test DB has no connection URL, so the host:port/name form is used
  assert.match(info.body.database, /\/|:/, 'a host:port/name or a url');
  assert.equal(info.body.port, config.port);
  assert.equal(info.body.convertCacheDir, config.convertCacheDir);
});

// ---- OPDS --------------------------------------------------------------

const opds = async (p: string) => {
  const res = await get(p);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /application\/atom\+xml/);
  return res.text();
};

test('the OPDS root advertises the four browse feeds', async () => {
  const xml = await opds('/opds/');
  assert.match(xml, /<title>SimpleOPDS Catalog<\/title>/);
  for (const href of ['/opds/catalogs', '/opds/authors', '/opds/series', '/opds/genres']) {
    assert.ok(xml.includes(`href="${href}"`), `links ${href}`);
  }
  assert.ok(xml.includes('rel="search"'));
});

test('OPDS search returns acquisition entries with download links', async () => {
  const xml = await opds('/opds/search?q=alpha');
  assert.ok(xml.includes('<title>Alpha Story</title>'));
  assert.ok(xml.includes(`href="/api/books/${bookId}/download?format=fb2"`));
  assert.ok(xml.includes(`href="/api/books/${bookId}/cover"`));
  assert.ok(xml.includes('<name>Adams Douglas</name>'));
});

test('OPDS catalogs, authors, series and genres each render a feed', async () => {
  assert.ok((await opds('/opds/catalogs')).includes('shelf'));
  assert.ok((await opds('/opds/authors')).includes('Adams Douglas'));
  assert.ok((await opds('/opds/series')).includes('Test Series'));
  assert.ok((await opds('/opds/genres')).includes('<entry>'));

  const authorId = (await db.get<{ id: number }>('SELECT id FROM authors LIMIT 1'))!.id;
  assert.ok((await opds(`/opds/author/${authorId}`)).includes('Alpha Story'));
  const serId = (await db.get<{ id: number }>('SELECT id FROM series LIMIT 1'))!.id;
  assert.ok((await opds(`/opds/serie/${serId}`)).includes('Beta Story'));
});

// The <id>, root <title> and rel="self" href are the feed's identity - a client
// dedupes and refreshes on them, so pin the exact strings for every route.
test('every OPDS feed carries its documented id, title and self link', async () => {
  const rootTitle = settings.S.title;
  const authorId = (await db.get<{ id: number }>('SELECT id FROM authors LIMIT 1'))!.id;
  const serId = (await db.get<{ id: number }>('SELECT id FROM series LIMIT 1'))!.id;
  const secId = (await repo.genreSections())[0].section_id;
  const genreId = (await repo.genresInSection(secId))[0].id;
  const shelfId = (await db.get<{ id: number }>("SELECT id FROM catalogs WHERE cat_name = 'shelf'"))!.id;
  const rootCatId = (await db.get<{ id: number }>("SELECT id FROM catalogs WHERE path = '.'"))!.id;

  const cases: [string, string, string, string][] = [
    ['/opds/', 'sopds:root', rootTitle, '/opds/'],
    ['/opds/search?q=alpha', 'sopds:search:alpha', 'Search: alpha', '/opds/search?q=alpha'],
    ['/opds/catalogs', `sopds:catalogs:${rootCatId}`, 'By catalogs', `/opds/catalogs?cat=${rootCatId}`],
    [`/opds/catalogs?cat=${shelfId}`, `sopds:catalogs:${shelfId}`, 'By catalogs', `/opds/catalogs?cat=${shelfId}`],
    ['/opds/authors', 'sopds:authors', 'By authors', '/opds/authors'],
    [`/opds/author/${authorId}`, `sopds:author:${authorId}`, 'Books by author', `/opds/author/${authorId}`],
    ['/opds/series', 'sopds:series', 'By series', '/opds/series'],
    [`/opds/serie/${serId}`, `sopds:serie:${serId}`, 'Books in series', `/opds/serie/${serId}`],
    ['/opds/genres', 'sopds:genres', 'By genres', '/opds/genres'],
    [`/opds/genres?section=${secId}`, `sopds:genres:${secId}`, 'Genre', `/opds/genres?section=${secId}`],
    [`/opds/genre/${genreId}`, `sopds:genre:${genreId}`, 'Books in genre', `/opds/genre/${genreId}`],
  ];
  for (const [url, id, title, self] of cases) {
    const xml = await opds(url);
    assert.ok(xml.includes(`<id>${id}</id>`), `${url}: <id>${id}</id>`);
    assert.ok(xml.includes(`<title>${title}</title>`), `${url}: <title>${title}</title>`);
    assert.ok(
      xml.includes(`<link rel="self" href="${self}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>`),
      `${url}: self link ${self}`,
    );
  }
});

test('the OPDS root is reachable with and without the trailing slash', async () => {
  const slash = await opds('/opds/');
  assert.ok(slash.includes('<id>sopds:root</id>'));
  const bare = await get('/opds');
  // express redirects /opds -> /opds/ or serves it directly; either way the root feed
  assert.ok([200, 301].includes(bare.status));
  const xml = bare.status === 200 ? await bare.text() : await (await get('/opds/')).text();
  assert.ok(xml.includes('<id>sopds:root</id>'));
});

test('OPDS root entries carry the exact id, title and live-count content', async () => {
  const xml = await opds('/opds/');
  for (const [id, title] of [
    ['nav:catalogs', 'By catalogs'],
    ['nav:authors', 'By authors'],
    ['nav:series', 'By series'],
    ['nav:genres', 'By genres'],
  ]) {
    assert.ok(xml.includes(`<id>${id}</id>`), id);
    assert.ok(xml.includes(`<title>${title}</title>`), title);
  }
  assert.match(xml, /<content type="text">Catalogs: \d+, books: 2<\/content>/);
  assert.match(xml, /<content type="text">Authors: 1<\/content>/);
});

test('OPDS search trims surrounding whitespace from the query', async () => {
  const xml = await opds('/opds/search?q=%20%20alpha%20story%20%20');
  assert.ok(xml.includes('<id>sopds:search:alpha story</id>'), 'the id uses the trimmed query');
  assert.ok(xml.includes('<title>Search: alpha story</title>'));
  assert.ok(xml.includes('<title>Alpha Story</title>'), 'and it still finds the book');
});

test('OPDS /opds/catalogs?cat=0 renders the empty root-level feed', async () => {
  const xml = await opds('/opds/catalogs?cat=0');
  assert.ok(xml.includes('<id>sopds:catalogs:0</id>'));
  assert.ok(
    xml.includes('<link rel="self" href="/opds/catalogs" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>'),
    'no ?cat= suffix on the self link when the id is 0',
  );
});

test('OPDS author/series feeds honour a ?prefix= filter', async () => {
  assert.ok((await opds('/opds/authors?prefix=Adams')).includes('Adams Douglas'));
  const none = await opds('/opds/authors?prefix=Zz');
  assert.ok(!none.includes('<entry>'), 'a non-matching prefix yields no entries');
  assert.ok((await opds('/opds/series?prefix=Test')).includes('Test Series'));
  assert.ok(!(await opds('/opds/series?prefix=Zz')).includes('<entry>'));
});

test('OPDS nav feeds link each child to its own sub-feed with a book count', async () => {
  const authorId = (await db.get<{ id: number }>('SELECT id FROM authors LIMIT 1'))!.id;
  const authors = await opds('/opds/authors');
  assert.ok(authors.includes(`<id>author:${authorId}</id>`), 'author entry id');
  assert.ok(authors.includes(`<link rel="subsection" href="/opds/author/${authorId}"`), 'author -> /opds/author/:id');
  assert.match(authors, /<content type="text">2 books<\/content>/);

  const serId = (await db.get<{ id: number }>('SELECT id FROM series LIMIT 1'))!.id;
  const seriesFeed = await opds('/opds/series');
  assert.ok(seriesFeed.includes(`<id>series:${serId}</id>`));
  assert.ok(seriesFeed.includes(`href="/opds/serie/${serId}"`));
  assert.match(seriesFeed, /<content type="text">2 books<\/content>/);

  const secId = (await repo.genreSections())[0].section_id;
  const genres = await opds('/opds/genres');
  assert.ok(genres.includes(`<id>section:${secId}</id>`));
  assert.ok(genres.includes(`href="/opds/genres?section=${secId}"`), 'section -> /opds/genres?section=');
  assert.match(genres, /<content type="text">\d+ books<\/content>/, 'section entry carries its book count');
  const genreId = (await repo.genresInSection(secId))[0].id;
  const sectionFeed = await opds(`/opds/genres?section=${secId}`);
  assert.ok(sectionFeed.includes(`<id>genre:${genreId}</id>`));
  assert.ok(sectionFeed.includes(`href="/opds/genre/${genreId}"`));
  assert.match(sectionFeed, /<content type="text">\d+ books<\/content>/);

  const catId = (await db.get<{ id: number }>("SELECT id FROM catalogs WHERE cat_name = 'shelf'"))!.id;
  const catFeed = await opds('/opds/catalogs');
  assert.ok(catFeed.includes(`<id>cat:${catId}</id>`));
  assert.ok(catFeed.includes(`href="/opds/catalogs?cat=${catId}"`));
  assert.match(catFeed, /<content type="text">2 books<\/content>/, 'child catalog book count');
});

test('OPDS search with no query yields an empty feed, not an error', async () => {
  const xml = await opds('/opds/search');
  assert.ok(xml.includes('<id>sopds:search:</id>'));
  assert.ok(xml.includes('<title>Search: </title>'));
  assert.ok(!xml.includes('<entry>'), 'no entries for an empty query');
});

test('OPDS escapes XML metacharacters rather than emitting broken markup', async () => {
  await db.run('UPDATE books SET title = ?, search_title = ? WHERE id = ?', [
    'Tom & <Jerry>',
    'TOM & <JERRY>',
    bookId,
  ]);
  const xml = await opds('/opds/search?q=tom');
  assert.ok(xml.includes('<title>Tom &amp; &lt;Jerry&gt;</title>'));
  assert.ok(!xml.includes('<Jerry>'));
});
