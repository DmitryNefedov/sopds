import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import db, { updateCounters } from '../db.js';
import type { Query, SqlParam, Tx } from '../db.js';
import { get as setting } from '../settings.js';
import { parseBook } from '../books/index.js';
import { FB2_HEAD_LIMIT, FB2_HEAD_MARKER } from '../books/fb2.js';
import { normalize, getLangCode } from '../lang.js';
import { zipEntries } from '../zip.js';
import type { BookMeta, ScanStats } from '../types.js';

// The collection walk: the raw, unguarded Scan operation. `runOnce()` is called
// directly by the CLI (`bin/scan.ts`) and the tests; the server reaches it only
// through the Scanner module (`scan/index.ts`), which adds the concurrency
// mutex, scheduling and folder-watch on top.
//
// Three things keep a 700k-book collection from taking all night:
//
//  * We read only a book's metadata header, never its body or cover. For FB2
//    that means inflating (and parsing) the few KB up to `</description>`
//    instead of the whole ~500 KB file — see `books/parseBook({ metaOnly })`.
//  * Books go to the database in bulk `UNNEST` statements, and a directory's
//    or archive's already-known filenames are fetched with one query, so the
//    walk costs a handful of round-trips per thousand books rather than five
//    per book.
//  * Archives (and directories) are read by a small pool of concurrent tasks.
//    Inflation happens on libuv's threadpool, so this actually uses the extra
//    cores; all database writes still funnel through one serialised writer.

type LogFn = (msg: string) => void;
interface ScanCtx {
  bookExtensions: string[];
  zipScan: boolean;
  deleteMissing: boolean;
  concurrency: number;
}
interface WalkStats {
  added: number;
  skipped: number;
  removed: number;
  bad: number;
  archives: number;
}

const CAT_NORMAL = 0;
const CAT_ZIP = 1;

/** Upper bound on books per bulk INSERT. Well under Postgres' parameter limit,
 *  and big enough that the per-round-trip cost stops mattering. The writer
 *  clamps it to `scanBatchSize` so a small batch size still publishes often. */
const MAX_ROWS_PER_STATEMENT = 500;

/** How often the catalog-wide counters are recomputed mid-scan. */
const COUNTER_INTERVAL_MS = 10_000;

// Populated at the start of each runOnce() from the current settings.
let CTX: ScanCtx = { bookExtensions: [], zipScan: true, deleteMissing: true, concurrency: 1 };

// ---- name to id caches -------------------------------------------------
// A 700k-book scan would otherwise re-run the same SELECT for every author,
// series, genre and directory it has already seen. These tables only ever grow
// during a scan and their names are unique, so a committed id stays valid; the
// caches are reset for each run and dropped if a batch is rolled back.
let authorIds = new Map<string, number>();
let seriesIds = new Map<string, number>();
let genreIds = new Map<string, number>();
let catalogIds = new Map<string, number>();

function resetCaches(): void {
  authorIds = new Map();
  seriesIds = new Map();
  genreIds = new Map();
  catalogIds = new Map();
}

/** Arrays are legal pg bind values but not part of the narrow `SqlParam` union. */
const arr = (...values: unknown[][]): SqlParam[] => values as unknown as SqlParam[];

// ---- per-transaction query helpers ----------------------------------

async function addCatTree(
  cx: Query,
  relPath: string,
  catType = CAT_NORMAL,
  size = 0,
): Promise<number> {
  const key = !relPath || relPath === '.' ? '.' : relPath;
  const cached = catalogIds.get(key);
  if (cached !== undefined) return cached;

  if (key === '.') {
    const existing = await cx.get<{ id: number }>('SELECT id FROM catalogs WHERE path = ?', ['.']);
    const id =
      existing?.id ??
      (await cx.get<{ id: number }>(
        `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size)
         VALUES (NULL, '.', '.', 0, 0) RETURNING id`,
      ))!.id;
    catalogIds.set('.', id);
    return id;
  }

  const existing = await cx.get<{ id: number }>('SELECT id FROM catalogs WHERE path = ?', [relPath]);
  if (existing) {
    catalogIds.set(key, existing.id);
    return existing.id;
  }
  const parent = path.dirname(relPath);
  const parentId = await addCatTree(cx, parent === relPath ? '.' : parent);
  const row = await cx.get<{ id: number }>(
    `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [parentId, path.basename(relPath), relPath, catType, size],
  );
  catalogIds.set(key, row!.id);
  return row!.id;
}

// ---- bulk name interning --------------------------------------------
// One INSERT ... ON CONFLICT DO NOTHING plus one SELECT ... = ANY() resolves
// every new author (series, genre) in a whole batch of books, instead of two
// statements per name.

async function internAuthors(cx: Query, names: string[]): Promise<void> {
  const missing = [...new Set(names.filter((n) => !authorIds.has(n)))];
  if (!missing.length) return;
  await cx.run(
    `INSERT INTO authors (full_name, search_full_name, lang_code)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
     ON CONFLICT (full_name) DO NOTHING`,
    arr(missing, missing.map((n) => normalize(n)), missing.map((n) => getLangCode(n))),
  );
  const rows = await cx.all<{ id: number; name: string }>(
    'SELECT id, full_name AS name FROM authors WHERE full_name = ANY($1::text[])',
    arr(missing),
  );
  for (const r of rows) authorIds.set(r.name, r.id);
}

async function internSeries(cx: Query, names: string[]): Promise<void> {
  const missing = [...new Set(names.filter((n) => !seriesIds.has(n)))];
  if (!missing.length) return;
  await cx.run(
    `INSERT INTO series (ser, search_ser, lang_code)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
     ON CONFLICT (ser) DO NOTHING`,
    arr(missing, missing.map((n) => normalize(n)), missing.map((n) => getLangCode(n))),
  );
  const rows = await cx.all<{ id: number; name: string }>(
    'SELECT id, ser AS name FROM series WHERE ser = ANY($1::text[])',
    arr(missing),
  );
  for (const r of rows) seriesIds.set(r.name, r.id);
}

async function internGenres(cx: Query, names: string[]): Promise<void> {
  const missing = [...new Set(names.filter((n) => !genreIds.has(n)))];
  if (!missing.length) return;
  await cx.run(
    `INSERT INTO genres (genre, section, subsection)
     SELECT g, 'Unknown genre', LEFT(g, 100) FROM UNNEST($1::text[]) AS g
     ON CONFLICT (genre) DO NOTHING`,
    arr(missing),
  );
  const rows = await cx.all<{ id: number; name: string }>(
    'SELECT id, genre AS name FROM genres WHERE genre = ANY($1::text[])',
    arr(missing),
  );
  for (const r of rows) genreIds.set(r.name, r.id);
}

// ---- bulk book insert -------------------------------------------------

interface PendingBook {
  filename: string;
  relDir: string;
  catalogId: number;
  catType: number;
  filesize: number;
  meta: BookMeta;
}

const bookKey = (relDir: string, filename: string): string => `${relDir}\u0000${filename}`;

/** Insert a chunk of books and their links. Returns how many rows were
 *  genuinely new (the rest were already in the catalog). */
async function insertBooks(cx: Query, rows: PendingBook[]): Promise<number> {
  // `ON CONFLICT DO UPDATE` cannot touch the same row twice in one statement,
  // so a duplicate (path, filename) inside the chunk has to go first.
  const byKey = new Map<string, PendingBook>();
  for (const r of rows) {
    const key = bookKey(r.relDir, r.filename);
    if (!byKey.has(key)) byKey.set(key, r);
  }
  const books = [...byKey.values()];
  if (!books.length) return 0;

  await internAuthors(cx, books.flatMap((b) => b.meta.authors.map((a) => a.slice(0, 128))));
  await internGenres(cx, books.flatMap((b) => b.meta.genres.map((g) => g.slice(0, 32))));
  await internSeries(
    cx,
    books.flatMap((b) => (b.meta.series ? [b.meta.series.title.slice(0, 150)] : [])),
  );

  const written = await cx.all<{ id: number; path: string; filename: string; inserted: boolean }>(
    `INSERT INTO books (filename, path, filesize, format, catalog_id, cat_type,
        doc_date, lang, title, search_title, annotation, lang_code, avail)
     SELECT *, 2 FROM UNNEST(
        $1::text[], $2::text[], $3::bigint[], $4::text[], $5::int[], $6::int[],
        $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::int[])
     ON CONFLICT (path, filename) DO UPDATE SET avail = 2
     RETURNING id, path, filename, (xmax = 0) AS inserted`,
    arr(
      books.map((b) => b.filename),
      books.map((b) => b.relDir),
      books.map((b) => b.filesize),
      books.map((b) => b.meta.format),
      books.map((b) => b.catalogId),
      books.map((b) => b.catType),
      books.map((b) => b.meta.docdate || ''),
      books.map((b) => b.meta.lang || ''),
      books.map((b) => b.meta.title),
      books.map((b) => normalize(b.meta.title)),
      books.map((b) => b.meta.annotation || ''),
      books.map((b) => b.meta.langCode),
    ),
  );

  const idFor = new Map<string, number>();
  let added = 0;
  for (const r of written) {
    idFor.set(bookKey(r.path, r.filename), r.id);
    if (r.inserted) added++;
  }

  const baBook: number[] = [];
  const baAuthor: number[] = [];
  const bgBook: number[] = [];
  const bgGenre: number[] = [];
  const bsBook: number[] = [];
  const bsSer: number[] = [];
  const bsNo: number[] = [];
  for (const b of books) {
    const id = idFor.get(bookKey(b.relDir, b.filename));
    if (id === undefined) continue;
    for (const a of b.meta.authors) {
      const aid = authorIds.get(a.slice(0, 128));
      if (aid !== undefined) {
        baBook.push(id);
        baAuthor.push(aid);
      }
    }
    for (const g of b.meta.genres) {
      const gid = genreIds.get(g.slice(0, 32));
      if (gid !== undefined) {
        bgBook.push(id);
        bgGenre.push(gid);
      }
    }
    if (b.meta.series) {
      const sid = seriesIds.get(b.meta.series.title.slice(0, 150));
      if (sid !== undefined) {
        bsBook.push(id);
        bsSer.push(sid);
        bsNo.push(b.meta.series.index || 0);
      }
    }
  }
  // DO NOTHING (unlike DO UPDATE) tolerates duplicates inside one statement,
  // so a book that lists the same author or genre twice needs no dedupe here.
  if (baBook.length)
    await cx.run(
      `INSERT INTO book_authors (book_id, author_id)
       SELECT * FROM UNNEST($1::int[], $2::int[]) ON CONFLICT DO NOTHING`,
      arr(baBook, baAuthor),
    );
  if (bgBook.length)
    await cx.run(
      `INSERT INTO book_genres (book_id, genre_id)
       SELECT * FROM UNNEST($1::int[], $2::int[]) ON CONFLICT DO NOTHING`,
      arr(bgBook, bgGenre),
    );
  if (bsBook.length)
    await cx.run(
      `INSERT INTO book_series (book_id, ser_id, ser_no)
       SELECT * FROM UNNEST($1::int[], $2::int[], $3::int[]) ON CONFLICT DO NOTHING`,
      arr(bsBook, bsSer, bsNo),
    );
  return added;
}

// ---- the writer -------------------------------------------------------
// The scan does not run in one transaction. Instead it commits every
// `batchSize` books so they become searchable/downloadable while the rest of
// the collection is still being read.
//
// Readers run concurrently; every statement they cause is queued by `enqueue()`,
// so exactly one of them is inside the transaction at a time.

class Writer {
  private tx: Tx | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private pending: PendingBook[] = [];
  private sinceFlush = 0;
  private readonly chunk: number;
  added = 0;

  constructor(
    private readonly batchSize: number,
    private readonly onFlush: () => Promise<void>,
  ) {
    this.chunk = Math.max(1, Math.min(MAX_ROWS_PER_STATEMENT, batchSize));
  }

  /** Queue `fn` behind whatever database work is already in flight. Everything
   *  that touches the transaction — including ending it — goes through here,
   *  so a statement can never reach the client after its COMMIT. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn);
    this.lock = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /** Queue `fn` against the open transaction, starting one if needed. */
  private serial<T>(fn: (cx: Query) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (!this.tx) this.tx = await db.begin();
      return fn(this.tx);
    });
  }

  /** Filenames already catalogued under `relPath`, so we never re-read them. */
  knownFilenames(relPath: string): Promise<Set<string>> {
    return this.serial(async (cx) => {
      const rows = await cx.all<{ filename: string }>('SELECT filename FROM books WHERE path = ?', [
        relPath,
      ]);
      return new Set(rows.map((r) => r.filename));
    });
  }

  /** Re-mark books we saw again this run as available, in bulk. */
  async markSeen(relPath: string, filenames: string[]): Promise<void> {
    for (let i = 0; i < filenames.length; i += 1000) {
      const slice = filenames.slice(i, i + 1000) as unknown as SqlParam;
      await this.serial((cx) =>
        cx.run('UPDATE books SET avail = 2 WHERE path = $1 AND filename = ANY($2::text[])', [
          relPath,
          slice,
        ]),
      );
    }
  }

  /** Mark every book of an untouched archive available in one statement. */
  markPathSeen(relPath: string): Promise<unknown> {
    return this.serial((cx) => cx.run('UPDATE books SET avail = 2 WHERE path = ?', [relPath]));
  }

  catalogRow(relPath: string): Promise<{ id: number; cat_size: number } | undefined> {
    return this.serial((cx) =>
      cx.get<{ id: number; cat_size: number }>('SELECT id, cat_size FROM catalogs WHERE path = ?', [
        relPath,
      ]),
    );
  }

  catalog(relPath: string, catType = CAT_NORMAL): Promise<number> {
    return this.serial((cx) => addCatTree(cx, relPath, catType, 0));
  }

  /** Reset an archive's size marker while we re-read it, so a scan interrupted
   *  mid-archive reads it again instead of trusting a half-populated catalog. */
  async beginArchive(relZip: string): Promise<number> {
    const id = await this.catalog(relZip, CAT_ZIP);
    await this.serial((cx) => cx.run('UPDATE catalogs SET cat_size = 0 WHERE id = ?', [id]));
    return id;
  }

  /** Stamp an archive's size — the "fully scanned" marker the next run skips
   *  on. Its books must already be in the transaction, so flush them first. */
  async finishArchive(catalogId: number, size: number): Promise<void> {
    await this.writeRows();
    await this.serial((cx) =>
      cx.run('UPDATE catalogs SET cat_size = ? WHERE id = ?', [size, catalogId]),
    );
  }

  /** Buffer a parsed book; writes go out one bulk statement at a time. */
  async add(book: PendingBook): Promise<void> {
    this.pending.push(book);
    if (this.pending.length >= this.chunk) await this.writeRows();
  }

  /** Count books we recognised and did not re-read. */
  async progressed(n: number): Promise<void> {
    this.sinceFlush += n;
    if (this.sinceFlush >= this.batchSize) await this.flush();
  }

  private async writeRows(): Promise<void> {
    if (!this.pending.length) return;
    const rows = this.pending;
    this.pending = [];
    this.added += await this.serial((cx) => insertBooks(cx, rows));
    await this.progressed(rows.length);
  }

  /** Commit whatever is pending and publish it. */
  async flush(): Promise<void> {
    await this.writeRows();
    const hadWork = this.sinceFlush > 0;
    await this.enqueue(async () => {
      if (!this.tx) return;
      await this.tx.commit();
      this.tx = null;
    });
    if (hadWork) {
      this.sinceFlush = 0;
      await this.onFlush();
    }
  }

  /** Discard the in-flight batch (caches may now be stale, so drop them). */
  async abort(): Promise<void> {
    this.pending = [];
    await this.enqueue(async () => {
      if (!this.tx) return;
      await this.tx.rollback();
      this.tx = null;
    });
    resetCaches();
  }
}

// ---- reading a book's metadata header --------------------------------

/** Whole-file formats need the whole file; FB2 only needs its header. */
async function readLooseHead(abs: string, ext: string, size: number): Promise<Buffer> {
  if (ext !== '.fb2') return fsp.readFile(abs);
  const want = Math.min(size, FB2_HEAD_LIMIT);
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// ---- the walk ---------------------------------------------------------

type Task = { kind: 'dir'; abs: string; files: string[] } | { kind: 'zip'; abs: string };

/** Yield one unit of work at a time so a huge tree is never fully listed. */
function* tasks(dir: string): Generator<Task> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      subdirs.push(path.join(dir, entry.name));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === '.zip') {
      if (CTX.zipScan) yield { kind: 'zip', abs: path.join(dir, entry.name) };
      continue;
    }
    if (CTX.bookExtensions.includes(ext)) files.push(entry.name);
  }
  if (files.length) yield { kind: 'dir', abs: dir, files };
  for (const sub of subdirs) yield* tasks(sub);
}

/** Run `fn` over the generator with at most `n` tasks in flight. */
async function pool<T>(
  items: Iterator<T>,
  n: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    for (let it = items.next(); !it.done && !failure; it = items.next()) {
      try {
        await fn(it.value);
      } catch (err) {
        failure ??= err;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  if (failure) throw failure;
}

async function processDir(
  writer: Writer,
  task: { abs: string; files: string[] },
  root: string,
  stats: WalkStats,
  log: LogFn,
): Promise<void> {
  const relDir = path.relative(root, task.abs) || '.';
  const known = await writer.knownFilenames(relDir);
  const seen = task.files.filter((f) => known.has(f));
  const fresh = task.files.filter((f) => !known.has(f));
  if (seen.length) {
    await writer.markSeen(relDir, seen);
    stats.skipped += seen.length;
    await writer.progressed(seen.length);
  }
  if (!fresh.length) return;

  const catalogId = await writer.catalog(relDir, CAT_NORMAL);
  for (const filename of fresh) {
    const abs = path.join(task.abs, filename);
    try {
      const size = (await fsp.stat(abs)).size;
      const ext = path.extname(filename).toLowerCase();
      const buf = await readLooseHead(abs, ext, size);
      await writer.add({
        filename,
        relDir,
        catalogId,
        catType: CAT_NORMAL,
        filesize: size,
        meta: parseBook(buf, filename, { metaOnly: true }),
      });
    } catch (err) {
      stats.bad++;
      log(`  bad book ${relDir}/${filename}: ${(err as Error).message}`);
    }
  }
}

async function processZip(
  writer: Writer,
  abs: string,
  root: string,
  stats: WalkStats,
  log: LogFn,
): Promise<void> {
  const relZip = path.relative(root, abs);
  const size = fs.statSync(abs).size;
  const existingCat = await writer.catalogRow(relZip);
  if (existingCat && Number(existingCat.cat_size) === size) {
    // Archive unchanged since the last scan: keep its books, read nothing.
    await writer.markPathSeen(relZip);
    stats.skipped++;
    await writer.progressed(1);
    return;
  }

  const catalogId = await writer.beginArchive(relZip);
  stats.archives++;
  const known = await writer.knownFilenames(relZip);
  const seen: string[] = [];

  try {
    for await (const entry of zipEntries(abs)) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!CTX.bookExtensions.includes(ext)) continue;
      if (known.has(entry.name)) {
        seen.push(entry.name);
        stats.skipped++;
        continue;
      }
      try {
        const buf =
          ext === '.fb2'
            ? await entry.readHead(FB2_HEAD_LIMIT, FB2_HEAD_MARKER)
            : await entry.read();
        await writer.add({
          filename: entry.name,
          relDir: relZip,
          catalogId,
          catType: CAT_ZIP,
          filesize: entry.size,
          meta: parseBook(buf, path.basename(entry.name), { metaOnly: true }),
        });
      } catch (err) {
        stats.bad++;
        log(`  bad book ${relZip}!${entry.name}: ${(err as Error).message}`);
      }
    }
    // Whole archive read: stamp its size as the "fully scanned" marker so the
    // next scan skips it. (Also covers a valid archive that held no books.)
    await writer.finishArchive(catalogId, size);
  } catch (err) {
    stats.bad++;
    log(`  bad archive ${relZip}: ${(err as Error).message}`);
  } finally {
    // Even when the archive turned out to be damaged half-way through, the
    // entries we did recognise have to stay available or the end-of-scan sweep
    // deletes them. (Ones we never reached are left pending, as before: the
    // archive keeps `cat_size = 0`, so the next run reads it again.)
    if (seen.length) {
      await writer.markSeen(relZip, seen);
      await writer.progressed(seen.length);
    }
  }
}

export interface RunOnceOpts {
  log?: LogFn;
  /** Called after every committed batch with the running added/skipped totals. */
  onProgress?: (p: { added: number; skipped: number }) => void;
}

export async function runOnce({
  log = console.log,
  onProgress,
}: RunOnceOpts = {}): Promise<ScanStats> {
  const rootDir = setting('rootLib');
  CTX = {
    bookExtensions: setting('bookExtensions')
      .split(/\s+/)
      .filter(Boolean)
      .map((e) => e.toLowerCase()),
    zipScan: setting('zipScan'),
    deleteMissing: setting('deleteMissing'),
    concurrency: scanConcurrency(),
  };
  if (!fs.existsSync(rootDir)) {
    log(`Book collection directory not found: ${rootDir}`);
    return {
      added: 0,
      skipped: 0,
      removed: 0,
      bad: 0,
      archives: 0,
      error: 'collection directory not found',
    };
  }

  const batchSize = Math.max(1, Number(setting('scanBatchSize')) || 10000);
  const stats: WalkStats = { added: 0, skipped: 0, removed: 0, bad: 0, archives: 0 };
  resetCaches();

  // Mark everything unavailable-pending; the walk re-marks what it finds and the
  // sweep at the end deletes what it never saw. This is its own commit so books
  // stay visible (avail = 1 is still "available") while the batches land.
  await db.run('UPDATE books SET avail = 1 WHERE avail <> 0');

  // `updateCounters()` is five COUNT(*) scans of growing tables. Committing
  // every `batchSize` books is cheap; recounting after each of them is not, and
  // on a 700k collection it would cost more than the walk. So publish every
  // batch and refresh the counters on a timer — `runOnce` recounts once more
  // at the end, so the numbers it leaves behind are exact.
  let countersAt = 0;
  const writer = new Writer(batchSize, async () => {
    stats.added = writer.added;
    if (Date.now() - countersAt >= COUNTER_INTERVAL_MS) {
      countersAt = Date.now();
      await updateCounters();
    }
    log(`  ... ${writer.added} books added so far`);
    onProgress?.({ added: stats.added, skipped: stats.skipped });
  });

  try {
    await pool(tasks(rootDir), CTX.concurrency, (task) =>
      task.kind === 'zip'
        ? processZip(writer, task.abs, rootDir, stats, log)
        : processDir(writer, task, rootDir, stats, log),
    );
    await writer.flush();
  } catch (err) {
    await writer.abort();
    throw err;
  }
  stats.added = writer.added;

  if (CTX.deleteMissing) {
    await db.tx(async (cx) => {
      const r = await cx.run('DELETE FROM books WHERE avail <= 1');
      stats.removed = r.rowCount;
    });
  }
  await updateCounters();
  log(
    `Scan done. added=${stats.added} skipped=${stats.skipped} removed=${stats.removed} bad=${stats.bad} archives=${stats.archives}`,
  );
  return stats;
}

/** 0 (the default) means "pick from the container's CPU allowance". */
function scanConcurrency(): number {
  const configured = Number(setting('scanConcurrency')) || 0;
  if (configured > 0) return Math.min(configured, 64);
  return Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length));
}
