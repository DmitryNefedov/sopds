import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// The scanner engine's seams, exercised directly: the settings->ctx read, the
// concurrency sizing, the directory-walk generator, the bounded `pool`, the
// per-format read plan, the name-interning + bulk book insert, and the Writer's
// batching. The end-to-end walk is in engine.test.ts / scan-concurrency.test.ts.

process.env.SOPDS_TEST_DB ??= 'mem';

const { default: db } = await import('../src/db/index.js');
const { initSchema } = await import('../src/db/schema.js');
const settings = await import('../src/services/settings.js');
const eng = await import('../src/services/scanner/engine.js');
const { NO_BYTES } = await import('../src/formats/index.js');
import type { BookMeta } from '../src/types.js';
import type { ZipEntry } from '../src/connectors/zip.js';
import type { ScanCtx, PendingBook } from '../src/services/scanner/engine.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-eng-unit-'));

before(async () => {
  await initSchema();
  await settings.loadSettings();
});

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.end();
});

// A fake settings reader so buildCtx/scanConcurrency can be driven without
// touching the live store.
const fakeGet =
  (over: Record<string, unknown>) =>
  (key: string): never =>
    (key in over ? over[key] : settings.get(key as never)) as never;

const meta = (over: Partial<BookMeta> = {}): BookMeta => ({
  title: 'T',
  authors: [],
  genres: [],
  series: null,
  lang: '',
  docdate: '',
  annotation: '',
  langCode: 0,
  format: 'fb2',
  ...over,
});

// ---- buildCtx ----------------------------------------------------------

test('buildCtx splits the extension list on whitespace, lowercases and drops blanks', () => {
  const ctx = eng.buildCtx(
    fakeGet({
      bookExtensions: '  .FB2   .ePub\t.MOBI  ',
      zipScan: true,
      deleteMissing: false,
      scanConcurrency: 3,
    }),
  );
  assert.deepEqual(ctx.bookExtensions, ['.fb2', '.epub', '.mobi']);
  assert.equal(ctx.zipScan, true);
  assert.equal(ctx.deleteMissing, false);
  assert.equal(ctx.concurrency, 3);
});

test('buildCtx carries zipScan / deleteMissing through unchanged', () => {
  const on = eng.buildCtx(fakeGet({ zipScan: true, deleteMissing: true, bookExtensions: '.fb2' }));
  assert.deepEqual([on.zipScan, on.deleteMissing], [true, true]);
  const off = eng.buildCtx(fakeGet({ zipScan: false, deleteMissing: false, bookExtensions: '.fb2' }));
  assert.deepEqual([off.zipScan, off.deleteMissing], [false, false]);
});

test('buildCtx needs a real tab/space split, not just a single space', () => {
  // A newline- and tab-separated list still has to come apart.
  const ctx = eng.buildCtx(fakeGet({ bookExtensions: '.fb2\n.epub', zipScan: true, deleteMissing: true }));
  assert.deepEqual(ctx.bookExtensions, ['.fb2', '.epub']);
});

// ---- scanConcurrency --------------------------------------------------

test('scanConcurrency: a configured value wins, capped at 64', () => {
  assert.equal(eng.scanConcurrency(fakeGet({ scanConcurrency: 4 })), 4);
  assert.equal(eng.scanConcurrency(fakeGet({ scanConcurrency: 999 })), 64, 'capped');
  assert.equal(eng.scanConcurrency(fakeGet({ scanConcurrency: 64 })), 64, 'exactly the cap');
});

test('scanConcurrency: 0 / unset falls back to the CPU allowance, clamped to [1, 8]', () => {
  const realAvail = os.availableParallelism;
  const realCpus = os.cpus;
  try {
    (os as { availableParallelism?: () => number }).availableParallelism = () => 100;
    assert.equal(eng.scanConcurrency(fakeGet({ scanConcurrency: 0 })), 8, 'upper clamp');

    (os as { availableParallelism?: () => number }).availableParallelism = () => 0;
    assert.equal(eng.scanConcurrency(fakeGet({ scanConcurrency: 0 })), 1, 'lower clamp');

    (os as { availableParallelism?: () => number }).availableParallelism = () => 4;
    assert.equal(eng.scanConcurrency(fakeGet({ scanConcurrency: 0 })), 4, 'passed straight through');

    // No availableParallelism at all -> fall back to the cpu count.
    (os as { availableParallelism?: () => number }).availableParallelism = undefined;
    (os as { cpus: () => unknown[] }).cpus = () => new Array(6);
    assert.equal(eng.scanConcurrency(fakeGet({ scanConcurrency: 0 })), 6);
  } finally {
    os.availableParallelism = realAvail;
    os.cpus = realCpus;
  }
});

test('buildCtx yields an empty extension list for a blank setting', () => {
  assert.deepEqual(
    eng.buildCtx(fakeGet({ bookExtensions: '   \t ', zipScan: true, deleteMissing: true })).bookExtensions,
    [],
  );
});

// ---- makeCounterGate ------------------------------------------------

test('makeCounterGate runs the refresh on the first call, then at most once per interval', async () => {
  let clock = 0;
  let runs = 0;
  const gate = eng.makeCounterGate(async () => {
    runs++;
  }, () => clock);

  clock = 5_000;
  await gate();
  assert.equal(runs, 1, 'the first call always refreshes');

  clock = 9_000;
  await gate();
  assert.equal(runs, 1, 'only 4s later: still throttled');

  clock = 15_000; // 10s since the last refresh
  await gate();
  assert.equal(runs, 2, 'the interval has passed');

  clock = 24_999;
  await gate();
  assert.equal(runs, 2, 'just under the interval again');
});

test('makeCounterGate uses subtraction, not addition, for the elapsed check', async () => {
  let clock = 0;
  let runs = 0;
  const gate = eng.makeCounterGate(async () => {
    runs++;
  }, () => clock);
  clock = 20_000;
  await gate(); // first call: refresh, last = 20000
  assert.equal(runs, 1);
  clock = 26_000; // elapsed 6000 (< 10000). `now + last` would be 46000 (>= 10000).
  await gate();
  assert.equal(runs, 1, 'still throttled 6s later');
});

// ---- tasks (the directory-walk generator) ---------------------------

const ctx = (over: Partial<ScanCtx> = {}): ScanCtx => ({
  bookExtensions: ['.fb2', '.epub'],
  zipScan: true,
  deleteMissing: true,
  concurrency: 1,
  ...over,
});

test('tasks yields a dir task per folder with book files, recursing into subdirs', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'walk-'));
  fs.writeFileSync(path.join(root, 'a.fb2'), 'x');
  fs.writeFileSync(path.join(root, 'note.txt'), 'x'); // not a book ext
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.epub'), 'x');
  fs.mkdirSync(path.join(root, 'empty'));

  const out = [...eng.tasks(root, ctx())];
  const dirs = out.filter((t) => t.kind === 'dir') as { abs: string; files: string[] }[];
  assert.deepEqual(dirs.map((d) => path.relative(root, d.abs) || '.').sort(), ['.', 'sub']);
  const rootDir = dirs.find((d) => d.abs === root)!;
  assert.deepEqual(rootDir.files, ['a.fb2'], 'only the book file, not note.txt');
  assert.ok(!out.some((t) => path.basename(t.kind === 'dir' ? t.abs : t.abs) === 'empty'));
});

test('tasks yields a zip task only when zipScan is on', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'walkzip-'));
  fs.writeFileSync(path.join(root, 'pack.zip'), 'x');
  fs.writeFileSync(path.join(root, 'book.fb2'), 'x');

  const withZip = [...eng.tasks(root, ctx({ zipScan: true }))];
  assert.equal(withZip.filter((t) => t.kind === 'zip').length, 1);

  const noZip = [...eng.tasks(root, ctx({ zipScan: false }))];
  assert.equal(noZip.filter((t) => t.kind === 'zip').length, 0);
  assert.equal(noZip.filter((t) => t.kind === 'dir').length, 1, 'the loose book is still found');
});

test('tasks filters by the configured extension list', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'walkext-'));
  fs.writeFileSync(path.join(root, 'keep.fb2'), 'x');
  fs.writeFileSync(path.join(root, 'skip.djvu'), 'x');
  const out = [...eng.tasks(root, ctx({ bookExtensions: ['.fb2'] }))] as {
    kind: string;
    files?: string[];
  }[];
  assert.deepEqual(out[0].files, ['keep.fb2']);
});

test('tasks yields nothing for an unreadable directory', () => {
  assert.deepEqual([...eng.tasks(path.join(tmp, 'does-not-exist'), ctx())], []);
});

test('tasks does not yield a dir task for a folder with no book files', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'walknone-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  assert.deepEqual([...eng.tasks(root, ctx())], []);
});

// ---- pool -----------------------------------------------------------

test('pool runs every item exactly once', async () => {
  const seen: number[] = [];
  await eng.pool([1, 2, 3, 4, 5][Symbol.iterator](), 2, async (n) => {
    seen.push(n);
  });
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5]);
});

test('pool keeps at most n tasks in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await eng.pool(items[Symbol.iterator](), 3, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
  });
  assert.equal(peak, 3, 'never more than 3 concurrent');
});

test('pool rethrows the first failure and stops pulling new work', async () => {
  const started: number[] = [];
  await assert.rejects(
    eng.pool(Array.from({ length: 50 }, (_, i) => i)[Symbol.iterator](), 2, async (n) => {
      started.push(n);
      if (n === 0) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 1));
    }),
    /boom/,
  );
  assert.ok(started.length < 50, `stopped early, ran ${started.length}`);
});

test('pool resolves without throwing when nothing fails', async () => {
  await eng.pool([1, 2][Symbol.iterator](), 1, async () => {});
});

// ---- readLooseForMeta / readEntryForMeta ---------------------------

test('readLooseForMeta returns no bytes for a filename-only format', async () => {
  const p = path.join(tmp, 'x.djvu');
  fs.writeFileSync(p, 'nonsense');
  assert.equal((await eng.readLooseForMeta(p, 'x.djvu', 8)).length, 0);
});

test('readLooseForMeta reads the whole file for an all-bytes format', async () => {
  const p = path.join(tmp, 'x.epub');
  fs.writeFileSync(p, 'abcdefgh');
  const buf = await eng.readLooseForMeta(p, 'x.epub', 8);
  assert.equal(buf.toString(), 'abcdefgh');
});

test('readLooseForMeta reads only the head, clamped to the file size', async () => {
  const p = path.join(tmp, 'x.fb2');
  fs.writeFileSync(p, Buffer.alloc(50, 65)); // 50 'A's
  const buf = await eng.readLooseForMeta(p, 'x.fb2', 10);
  assert.equal(buf.length, 10, 'want = min(size arg, plan.limit) and the file is long enough');
  assert.equal(buf.toString(), 'AAAAAAAAAA');
});

test('readEntryForMeta dispatches on the plan the same way', async () => {
  const calls: string[] = [];
  const entry = {
    read: async () => {
      calls.push('read');
      return Buffer.from('all');
    },
    readHead: async (limit: number, stopAt?: Buffer) => {
      calls.push(`head:${limit}:${stopAt ? 'marker' : 'none'}`);
      return Buffer.from('head');
    },
  } as unknown as ZipEntry;

  assert.equal((await eng.readEntryForMeta(entry, 'a.djvu')).length, 0, 'none: no inflate at all');
  assert.equal((await eng.readEntryForMeta(entry, 'a.epub')).toString(), 'all');
  assert.equal((await eng.readEntryForMeta(entry, 'a.fb2')).toString(), 'head');
  assert.deepEqual(calls, ['read', 'head:262144:marker'], 'epub -> read(), fb2 -> readHead(limit, marker)');
});

// ---- DB-backed helpers ---------------------------------------------

beforeEach(async () => {
  await db.exec(
    'TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE',
  );
  eng.resetCaches();
});

test('addCatTree creates the "." root once and then serves it from cache', async () => {
  const a = await eng.addCatTree(db, '.');
  const b = await eng.addCatTree(db, ''); // empty path is the same root
  assert.equal(a, b);
  // Delete the row; a cached lookup still returns the id without re-querying.
  await db.run('DELETE FROM catalogs');
  assert.equal(await eng.addCatTree(db, '.'), a, 'served from cache, not re-read');
});

test('addCatTree reuses an existing "." row rather than inserting a second', async () => {
  await db.run(
    `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size)
     VALUES (NULL, '.', '.', 0, 0)`,
  );
  const id = await eng.addCatTree(db, '.');
  assert.equal((await db.get<{ c: number }>("SELECT COUNT(*)::int c FROM catalogs WHERE path='.'"))!.c, 1);
  assert.ok(id > 0);
});

test('addCatTree builds the parent chain and links each level to its real parent', async () => {
  const leaf = await eng.addCatTree(db, 'a/b/c');
  const rows = await db.all<{ path: string; parent_id: number | null; id: number }>(
    'SELECT id, path, parent_id FROM catalogs ORDER BY path',
  );
  const byPath = new Map(rows.map((r) => [r.path, r]));
  assert.equal(byPath.get('a/b/c')!.id, leaf);
  assert.equal(byPath.get('a/b/c')!.parent_id, byPath.get('a/b')!.id, 'c under a/b, not the root');
  assert.equal(byPath.get('a/b')!.parent_id, byPath.get('a')!.id);
  assert.equal(byPath.get('a')!.parent_id, byPath.get('.')!.id, 'top level under the "." root');
});

test('addCatTree returns an existing non-root catalog straight away', async () => {
  await eng.addCatTree(db, 'x/y');
  eng.resetCaches();
  const again = await eng.addCatTree(db, 'x/y');
  assert.equal((await db.get<{ c: number }>("SELECT COUNT(*)::int c FROM catalogs WHERE path='x/y'"))!.c, 1);
  assert.ok(again > 0);
});

test('addCatTree caches a freshly-created nested catalog and an existing one it re-read', async () => {
  // freshly created -> cached
  const made = await eng.addCatTree(db, 'p/q');
  await db.run('DELETE FROM catalogs WHERE path IN (?, ?, ?)', ['p/q', 'p', '.']);
  assert.equal(await eng.addCatTree(db, 'p/q'), made, 'served from cache after the row was deleted');

  // re-read from the table (cache cleared) -> cached again
  eng.resetCaches();
  await db.run(
    `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size) VALUES (NULL, '.', '.', 0, 0)`,
  );
  const rootId = (await db.get<{ id: number }>("SELECT id FROM catalogs WHERE path='.'"))!.id;
  await db.run(
    `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size) VALUES (?, 'r', 'r', 0, 0)`,
    [rootId],
  );
  const readBack = await eng.addCatTree(db, 'r'); // hits the "existing" branch, caches it
  await db.run("DELETE FROM catalogs WHERE path = 'r'");
  assert.equal(await eng.addCatTree(db, 'r'), readBack, 'the re-read id is cached too');
});

test('internAuthors dedups within the batch, skips names already cached, and fills the id map', async () => {
  await eng.internAuthors(db, ['Alice', 'Alice', 'Bob']);
  const rows = await db.all<{ full_name: string }>('SELECT full_name FROM authors ORDER BY full_name');
  assert.deepEqual(rows.map((r) => r.full_name), ['Alice', 'Bob'], 'each name inserted once');

  // A second call for a known name must not touch the table.
  await eng.internAuthors(db, ['Alice']);
  assert.equal((await db.get<{ c: number }>('SELECT COUNT(*)::int c FROM authors'))!.c, 2);

  // A no-op call with nothing missing returns without a write.
  await eng.internAuthors(db, []);
});

test('internSeries / internGenres behave the same way', async () => {
  await eng.internSeries(db, ['Saga', 'Saga']);
  await eng.internGenres(db, ['sf', 'sf', 'fantasy']);
  assert.equal((await db.get<{ c: number }>('SELECT COUNT(*)::int c FROM series'))!.c, 1);
  assert.equal((await db.get<{ c: number }>('SELECT COUNT(*)::int c FROM genres'))!.c, 2);
  await eng.internSeries(db, ['Saga']); // cached: no-op
  await eng.internGenres(db, ['sf']); // cached: no-op
  assert.equal((await db.get<{ c: number }>('SELECT COUNT(*)::int c FROM series'))!.c, 1);
});

// ---- insertBooks --------------------------------------------------

const pending = (over: Partial<PendingBook> = {}): PendingBook => ({
  filename: 'b.fb2',
  relDir: 'd',
  catalogId: 0,
  catType: 0,
  filesize: 10,
  meta: meta(),
  ...over,
});

async function withCatalog(relDir: string): Promise<number> {
  return db.tx((cx) => eng.addCatTree(cx, relDir));
}

test('insertBooks writes each book once, collapsing a duplicate (path, filename) in the chunk', async () => {
  const cat = await withCatalog('d');
  eng.resetCaches();
  const added = await db.tx((cx) =>
    eng.insertBooks(cx, [
      pending({ filename: 'dup.fb2', catalogId: cat, meta: meta({ title: 'First' }) }),
      pending({ filename: 'dup.fb2', catalogId: cat, meta: meta({ title: 'Second' }) }),
      pending({ filename: 'other.fb2', catalogId: cat }),
    ]),
  );
  assert.equal(added, 2, 'two genuinely new rows');
  const rows = await db.all<{ title: string; catalog_id: number }>(
    'SELECT title, catalog_id FROM books ORDER BY filename',
  );
  assert.deepEqual(rows.map((t) => t.title), ['First', 'T']);
  assert.ok(
    rows.every((r) => r.catalog_id === cat),
    'each book is filed under the catalog it was given, not null',
  );
  assert.equal(
    (await db.get<{ c: number }>('SELECT COUNT(*)::int c FROM series'))!.c,
    0,
    'seriesless books create no stray series rows',
  );
});

test('insertBooks returns 0 for an empty chunk', async () => {
  const added = await db.tx((cx) => eng.insertBooks(cx, []));
  assert.equal(added, 0);
});

test('insertBooks reports only the newly-inserted rows, not the re-marked ones', async () => {
  const cat = await withCatalog('d');
  eng.resetCaches();
  const first = await db.tx((cx) => eng.insertBooks(cx, [pending({ catalogId: cat, filename: 'x.fb2' })]));
  assert.equal(first, 1);
  eng.resetCaches();
  const second = await db.tx((cx) =>
    eng.insertBooks(cx, [
      pending({ catalogId: cat, filename: 'x.fb2' }), // already there -> re-marked
      pending({ catalogId: cat, filename: 'y.fb2' }), // new
    ]),
  );
  assert.equal(second, 1, 'only y.fb2 is new');
});

test('insertBooks links authors, genres and a series with its index, truncating long names', async () => {
  const cat = await withCatalog('d');
  eng.resetCaches();
  const longAuthor = 'A'.repeat(200); // > 128
  const longGenre = 'g'.repeat(50); // > 32
  const longSeries = 's'.repeat(200); // > 150
  await db.tx((cx) =>
    eng.insertBooks(cx, [
      pending({
        catalogId: cat,
        filename: 'linked.fb2',
        meta: meta({
          title: 'Linked',
          authors: [longAuthor, 'Second Author'],
          genres: [longGenre, 'sf'],
          series: { title: longSeries, index: 7 },
        }),
      }),
    ]),
  );
  const book = await db.get<{ id: number }>("SELECT id FROM books WHERE filename = 'linked.fb2'");
  const authors = await db.all<{ full_name: string }>(
    'SELECT a.full_name FROM authors a JOIN book_authors ba ON ba.author_id = a.id WHERE ba.book_id = ? ORDER BY a.full_name',
    [book!.id],
  );
  assert.deepEqual(
    authors.map((a) => a.full_name).sort(),
    [longAuthor.slice(0, 128), 'Second Author'].sort(),
    'author name stored truncated to 128',
  );
  const genres = await db.all<{ genre: string }>(
    'SELECT g.genre FROM genres g JOIN book_genres bg ON bg.genre_id = g.id WHERE bg.book_id = ?',
    [book!.id],
  );
  assert.ok(genres.some((g) => g.genre === longGenre.slice(0, 32)));
  const ser = await db.get<{ ser: string; ser_no: number }>(
    'SELECT s.ser, bs.ser_no FROM series s JOIN book_series bs ON bs.ser_id = s.id WHERE bs.book_id = ?',
    [book!.id],
  );
  assert.equal(ser!.ser, longSeries.slice(0, 150));
  assert.equal(Number(ser!.ser_no), 7);
});

test('insertBooks stores a seriesless / index-less book without a series row, index defaulting to 0', async () => {
  const cat = await withCatalog('d');
  eng.resetCaches();
  await db.tx((cx) =>
    eng.insertBooks(cx, [
      pending({ catalogId: cat, filename: 'noidx.fb2', meta: meta({ series: { title: 'S' } }) }),
    ]),
  );
  const book = await db.get<{ id: number }>("SELECT id FROM books WHERE filename = 'noidx.fb2'");
  const ser = await db.get<{ ser_no: number }>('SELECT ser_no FROM book_series WHERE book_id = ?', [
    book!.id,
  ]);
  assert.equal(Number(ser!.ser_no), 0, 'a missing index becomes 0');
});

test('insertBooks passes the zip locators through, and null for a loose book', async () => {
  const cat = await withCatalog('z');
  eng.resetCaches();
  await db.tx((cx) =>
    eng.insertBooks(cx, [
      pending({
        catalogId: cat,
        relDir: 'z',
        filename: 'inzip.fb2',
        loc: { offset: 111, csize: 22, method: 8 },
      }),
      pending({ catalogId: cat, relDir: 'z', filename: 'loose.fb2' }),
    ]),
  );
  const inzip = await db.get<{ zip_offset: number; zip_csize: number; zip_method: number }>(
    "SELECT zip_offset, zip_csize, zip_method FROM books WHERE filename = 'inzip.fb2'",
  );
  assert.deepEqual(
    { o: Number(inzip!.zip_offset), c: Number(inzip!.zip_csize), m: inzip!.zip_method },
    { o: 111, c: 22, m: 8 },
  );
  const loose = await db.get<{ zip_offset: number | null }>(
    "SELECT zip_offset FROM books WHERE filename = 'loose.fb2'",
  );
  assert.equal(loose!.zip_offset, null);
});

test('insertBooks keeps docdate / lang / annotation, and stores empty strings when absent', async () => {
  const cat = await withCatalog('d');
  eng.resetCaches();
  await db.tx((cx) =>
    eng.insertBooks(cx, [
      pending({
        catalogId: cat,
        filename: 'full.fb2',
        meta: meta({ docdate: '2021', lang: 'en', annotation: 'blurb' }),
      }),
      pending({ catalogId: cat, filename: 'bare.fb2', meta: meta() }),
    ]),
  );
  const full = await db.get<{ doc_date: string; lang: string; annotation: string }>(
    "SELECT doc_date, lang, annotation FROM books WHERE filename = 'full.fb2'",
  );
  assert.deepEqual(
    { d: full!.doc_date, l: full!.lang, a: full!.annotation },
    { d: '2021', l: 'en', a: 'blurb' },
  );
  const bare = await db.get<{ doc_date: string; lang: string; annotation: string }>(
    "SELECT doc_date, lang, annotation FROM books WHERE filename = 'bare.fb2'",
  );
  assert.deepEqual(
    { d: bare!.doc_date, l: bare!.lang, a: bare!.annotation },
    { d: '', l: '', a: '' },
  );
});

// ---- Writer ---------------------------------------------------------

test('Writer.chunk is the batch size, clamped to [1, MAX_ROWS_PER_STATEMENT]', () => {
  const chunkOf = (batchSize: number): number => {
    const w = new eng.Writer(batchSize, async () => {}) as unknown as { chunk: number };
    return w.chunk;
  };
  assert.equal(chunkOf(10), 10);
  assert.equal(chunkOf(0), 1, 'never below 1');
  assert.equal(chunkOf(100_000), 500, 'never above MAX_ROWS_PER_STATEMENT');
});

test('Writer.knownFilenames returns the set already catalogued under a path', async () => {
  await db.exec(
    'TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE',
  );
  await db.run(
    `INSERT INTO books (filename, path, format, title, search_title, avail)
     VALUES ('a.fb2','d','fb2','A','a',2), ('b.fb2','d','fb2','B','b',2), ('c.fb2','e','fb2','C','c',2)`,
  );
  const w = new eng.Writer(10, async () => {});
  const known = await w.knownFilenames('d');
  assert.deepEqual([...known].sort(), ['a.fb2', 'b.fb2']);
  await w.abort();
});

test('Writer.markSeen re-marks books available in batches of 1000', async () => {
  await db.exec(
    'TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE',
  );
  const names: string[] = [];
  const values: string[] = [];
  for (let i = 0; i < 1500; i++) {
    names.push(`f${i}.fb2`);
    values.push(`('f${i}.fb2','d','fb2','x','x',0)`);
  }
  // insert in manageable statements
  for (let i = 0; i < values.length; i += 300) {
    await db.run(
      `INSERT INTO books (filename, path, format, title, search_title, avail) VALUES ${values
        .slice(i, i + 300)
        .join(',')}`,
    );
  }
  const w = new eng.Writer(10, async () => {});
  await w.markSeen('d', names); // 1500 -> two UPDATE batches
  await w.flush();
  const c = await db.get<{ c: number }>("SELECT COUNT(*)::int c FROM books WHERE avail = 2");
  assert.equal(c!.c, 1500, 'every one of the 1500 was re-marked across both batches');
});

test('Writer.flush commits pending work and calls onFlush once, but not on an empty flush', async () => {
  await db.exec(
    'TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE',
  );
  let flushes = 0;
  const w = new eng.Writer(1, async () => {
    flushes++;
  });
  await w.flush();
  assert.equal(flushes, 0, 'nothing happened, so onFlush is not called');

  const cat = await withCatalog('d');
  eng.resetCaches();
  await w.add({
    filename: 'w.fb2',
    relDir: 'd',
    catalogId: cat,
    catType: 0,
    filesize: 1,
    meta: meta(),
  });
  await w.flush();
  assert.equal(flushes, 1, 'work was committed, so onFlush ran');
  assert.equal((await db.get<{ c: number }>('SELECT COUNT(*)::int c FROM books'))!.c, 1);
});

test('Writer.abort rolls the batch back and drops the id caches so no stale id is reused', async () => {
  await db.exec(
    'TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE',
  );
  eng.resetCaches();
  const w = new eng.Writer(1000, async () => {});
  // `catalog()` opens a transaction and creates + caches a brand-new catalog
  // row; nothing has flushed, so it is still uncommitted.
  const stale = await w.catalog('fresh/dir');
  await w.abort(); // rolls the catalog back AND must clear the name/id caches

  assert.equal(
    (await db.get<{ c: number }>("SELECT COUNT(*)::int c FROM catalogs WHERE path = 'fresh/dir'"))!.c,
    0,
    'the catalog row was rolled back',
  );

  // A later writer asks for the same path. If abort() had NOT reset the cache it
  // would hand back `stale` - an id with no row behind it.
  const w2 = new eng.Writer(1000, async () => {});
  const again = await w2.catalog('fresh/dir');
  await w2.flush(); // commit it
  assert.ok(
    await db.get('SELECT 1 FROM catalogs WHERE id = ?', [again]),
    'the re-resolved catalog id points at a real row',
  );
  assert.notEqual(again, stale, 'a fresh row, not the rolled-back one');
});

test('Writer.abort empties the pending buffer so a later flush writes nothing stale', async () => {
  await db.exec('TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE');
  const cat = await db.tx((cx) => eng.addCatTree(cx, 'd'));
  eng.resetCaches();
  const w = new eng.Writer(1000, async () => {});
  await w.add({ filename: 'a.fb2', relDir: 'd', catalogId: cat, catType: 0, filesize: 1, meta: meta() });
  await w.abort();
  await w.flush(); // must be a clean no-op, not a replay of a poisoned buffer
  assert.equal((await db.get<{ c: number }>('SELECT COUNT(*)::int c FROM books'))!.c, 0);
});

// The transaction mechanics: spy on db.begin so a commit / rollback / a second
// BEGIN is visible even though PGlite is a single connection.
function spyBegin() {
  const real = db.begin.bind(db);
  const counts = { begin: 0, commit: 0, rollback: 0 };
  db.begin = async () => {
    counts.begin++;
    const tx = await real();
    return {
      ...tx,
      commit: async () => {
        counts.commit++;
        return tx.commit();
      },
      rollback: async () => {
        counts.rollback++;
        return tx.rollback();
      },
    };
  };
  return { counts, restore: () => void (db.begin = real) };
}

test('Writer.serial reuses one transaction across queued statements', async () => {
  await db.exec('TRUNCATE books, catalogs, counters RESTART IDENTITY CASCADE');
  const spy = spyBegin();
  try {
    const w = new eng.Writer(10, async () => {});
    await w.knownFilenames('a');
    await w.knownFilenames('b');
    await w.catalogRow('c');
    assert.equal(spy.counts.begin, 1, 'three reads, one BEGIN');
    await w.abort();
  } finally {
    spy.restore();
  }
});

test('Writer.flush issues exactly one COMMIT for the batch; an empty flush commits nothing', async () => {
  await db.exec('TRUNCATE books, catalogs, counters RESTART IDENTITY CASCADE');
  const spy = spyBegin();
  try {
    const cat = await db.tx((cx) => eng.addCatTree(cx, 'd'));
    eng.resetCaches();
    const w = new eng.Writer(10, async () => {});
    await w.add({ filename: 'a.fb2', relDir: 'd', catalogId: cat, catType: 0, filesize: 1, meta: meta() });
    await w.flush();
    assert.equal(spy.counts.commit, 1, 'the batch is committed');
    await w.flush();
    assert.equal(spy.counts.commit, 1, 'nothing pending: no second COMMIT');
  } finally {
    spy.restore();
  }
});

test('Writer.abort issues a ROLLBACK when a transaction is open, and none when it is not', async () => {
  await db.exec('TRUNCATE books, catalogs, counters RESTART IDENTITY CASCADE');
  const spy = spyBegin();
  try {
    const w = new eng.Writer(10, async () => {});
    await w.abort();
    assert.equal(spy.counts.rollback, 0, 'no tx open: nothing to roll back');
    await w.knownFilenames('x'); // opens a tx
    await w.abort();
    assert.equal(spy.counts.rollback, 1);
  } finally {
    spy.restore();
  }
});

test('Writer.add flushes a full chunk to the database as soon as it fills', async () => {
  await db.exec('TRUNCATE books, catalogs, counters RESTART IDENTITY CASCADE');
  const cat = await db.tx((cx) => eng.addCatTree(cx, 'd'));
  eng.resetCaches();
  const w = new eng.Writer(2, async () => {});
  const add = (n: string) =>
    w.add({ filename: n, relDir: 'd', catalogId: cat, catType: 0, filesize: 1, meta: meta() });
  await add('a.fb2');
  assert.equal(w.added, 0, 'one book: chunk (2) not full yet');
  await add('b.fb2');
  assert.equal(w.added, 2, 'chunk full: both written straight away');
  await w.abort();
});

test('Writer.progressed flushes once the running count reaches the batch size, not before', async () => {
  await db.exec('TRUNCATE books, catalogs, counters RESTART IDENTITY CASCADE');
  let flushes = 0;
  const w = new eng.Writer(3, async () => {
    flushes++;
  });
  await w.progressed(2);
  assert.equal(flushes, 0, '2 < 3: no flush');
  await w.progressed(1);
  assert.equal(flushes, 1, 'reached 3: flushed');
  await w.progressed(1);
  assert.equal(flushes, 1, 'counter reset after the flush, back under the threshold');
});

test('Writer.beginArchive zeroes the archive size marker so an interrupted re-read starts over', async () => {
  await db.exec('TRUNCATE books, catalogs, counters RESTART IDENTITY CASCADE');
  await db.run(
    `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size)
     VALUES (NULL, 'p.zip', 'p.zip', 1, 4096)`,
  );
  eng.resetCaches();
  const w = new eng.Writer(10, async () => {});
  const id = await w.beginArchive('p.zip');
  await w.flush();
  const row = await db.get<{ cat_size: number }>('SELECT cat_size FROM catalogs WHERE id = ?', [id]);
  assert.equal(Number(row!.cat_size), 0, 'cat_size reset to 0 while the archive is being re-read');
});

test('Writer.markSeenAt refreshes avail and the zip locators for known entries', async () => {
  await db.exec('TRUNCATE books, catalogs, counters RESTART IDENTITY CASCADE');
  await db.run(
    `INSERT INTO books (filename, path, format, title, search_title, avail, zip_offset, zip_csize, zip_method)
     VALUES ('e.fb2','z.zip','fb2','E','e',1,1,1,0)`,
  );
  const w = new eng.Writer(10, async () => {});
  await w.markSeenAt('z.zip', [{ name: 'e.fb2', loc: { offset: 900, csize: 90, method: 8 } }]);
  await w.flush();
  const row = await db.get<{ avail: number; zip_offset: number; zip_csize: number; zip_method: number }>(
    "SELECT avail, zip_offset, zip_csize, zip_method FROM books WHERE filename = 'e.fb2'",
  );
  assert.equal(row!.avail, 2, 're-marked available');
  assert.deepEqual(
    { o: Number(row!.zip_offset), c: Number(row!.zip_csize), m: row!.zip_method },
    { o: 900, c: 90, m: 8 },
    'the fresh offsets from this pass overwrite the stale ones',
  );
});

test('Writer.markPathSeen re-marks every book of an untouched archive', async () => {
  await db.exec('TRUNCATE books, catalogs, counters RESTART IDENTITY CASCADE');
  await db.run(
    `INSERT INTO books (filename, path, format, title, search_title, avail)
     VALUES ('a.fb2','arc.zip','fb2','A','a',1), ('b.fb2','arc.zip','fb2','B','b',1)`,
  );
  const w = new eng.Writer(10, async () => {});
  await w.markPathSeen('arc.zip');
  await w.flush();
  assert.equal(
    (await db.get<{ c: number }>("SELECT COUNT(*)::int c FROM books WHERE path='arc.zip' AND avail=2"))!.c,
    2,
  );
});

test('Writer.finishArchive stamps the scanned size after flushing its books', async () => {
  await db.exec('TRUNCATE books, catalogs, counters RESTART IDENTITY CASCADE');
  await db.run(
    `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size)
     VALUES (NULL, 'q.zip', 'q.zip', 1, 0)`,
  );
  eng.resetCaches();
  const w = new eng.Writer(10, async () => {});
  const id = await w.beginArchive('q.zip');
  await w.finishArchive(id, 7777);
  await w.flush();
  const row = await db.get<{ cat_size: number }>('SELECT cat_size FROM catalogs WHERE id = ?', [id]);
  assert.equal(Number(row!.cat_size), 7777);
});
