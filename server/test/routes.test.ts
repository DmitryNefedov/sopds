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
});

test('GET /api/admin/scan reports scanner state, and /api/admin/info the runtime', async () => {
  const scan = await json('/api/admin/scan');
  assert.equal(scan.body.running, false);
  assert.equal(typeof scan.body.cron, 'string');
  assert.equal(typeof scan.body.watch.watching, 'boolean');

  const info = await json('/api/admin/info');
  assert.equal(info.body.node, process.version);
  assert.ok(info.body.database);
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
