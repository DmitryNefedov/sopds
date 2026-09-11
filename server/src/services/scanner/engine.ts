import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import db from '../../db/index.js';
import { updateCounters } from '../../db/schema.js';
import type { Query, SqlParam, Tx } from '../../db/index.js';
import { get as setting } from '../settings.js';
import { parseBook, metaReadPlan, NO_BYTES } from '../../formats/index.js';
import { normalize, getLangCode } from '../../utils/lang.js';
import { zipEntries } from '../../connectors/zip.js';
import type { ZipEntry, ZipLocation } from '../../connectors/zip.js';
import type { BookMeta, ScanStats } from '../../types.js';

// The collection walk: the raw Scan that the CLI and the tests call directly,
// while the server goes through `scanner/index.ts` for the mutex, schedule and
// folder-watch. What keeps a 700k-book collection from taking all night:
//
//  * only a book's metadata header is read, never its body or cover
//    (`formats/parseBook({ metaOnly })`)
//  * books go out in bulk `UNNEST` statements, and a directory's known
//    filenames arrive in one query — round-trips per thousand books, not per book
//  * a small pool of readers works in parallel (inflation runs on libuv's
//    threadpool) while every write funnels through one serialised Writer

type LogFn = (msg: string) => void;
export interface ScanCtx {
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

type Setting = typeof setting;

/** Read the walk's tunables out of the live settings in one place, so the walk
 *  itself takes them as a plain argument and can be driven from a test. */
export function buildCtx(get: Setting = setting): ScanCtx {
  return {
    bookExtensions: get('bookExtensions').toLowerCase().match(/\S+/g) ?? [],
    zipScan: get('zipScan'),
    deleteMissing: get('deleteMissing'),
    concurrency: scanConcurrency(get),
  };
}

/** Upper bound on books per bulk INSERT: well under Postgres' parameter limit,
 *  big enough that round-trip cost stops mattering. The Writer clamps it to
 *  `scanBatchSize` so a small batch size still publishes often. */
const MAX_ROWS_PER_STATEMENT = 500;

/** How often the catalog-wide counters are recomputed mid-scan. */
const COUNTER_INTERVAL_MS = 10_000;

/**
 * A throttle for the mid-scan counter refresh: calling the returned function
 * runs `refresh` at most once per `COUNTER_INTERVAL_MS`, and always on the
 * first call. `updateCounters()` is five COUNT(*) scans, far too costly to run
 * on every committed batch; `runOnce` recounts once at the end so the final
 * numbers are exact regardless.
 */
export function makeCounterGate(
  refresh: () => Promise<void>,
  now: () => number = Date.now,
): () => Promise<void> {
  let last = -Infinity;
  return async () => {
    if (now() - last >= COUNTER_INTERVAL_MS) {
      last = now();
      await refresh();
    }
  };
}

// ---- name to id caches -------------------------------------------------
// A 700k-book scan would otherwise re-run the same SELECT for every author,
// series, genre and directory it has already seen. These tables only ever grow
// during a scan and their names are unique, so a committed id stays valid; the
// caches are reset for each run and dropped if a batch is rolled back.
const authorIds = new Map<string, number>();
const seriesIds = new Map<string, number>();
const genreIds = new Map<string, number>();
const catalogIds = new Map<string, number>();

export function resetCaches(): void {
  for (const m of [authorIds, seriesIds, genreIds, catalogIds]) m.clear();
}

/** Arrays are legal pg bind values but not part of the narrow `SqlParam` union. */
const arr = (...values: unknown[][]): SqlParam[] => values as unknown as SqlParam[];

// ---- per-transaction query helpers ----------------------------------

export async function addCatTree(
  cx: Query,
  relPath: string,
  catType = CAT_NORMAL,
  size = 0,
): Promise<number> {
  const key = relPath || '.';
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

  const existing = await cx.get<{ id: number }>('SELECT id FROM catalogs WHERE path = ?', [key]);
  if (existing) {
    catalogIds.set(key, existing.id);
    return existing.id;
  }
  // `path.dirname` always shrinks a relative path toward '.', so the recursion
  // terminates in the `key === '.'` branch above.
  const parentId = await addCatTree(cx, path.dirname(key));
  const row = await cx.get<{ id: number }>(
    `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [parentId, path.basename(key), key, catType, size],
  );
  catalogIds.set(key, row!.id);
  return row!.id;
}

// ---- bulk name interning --------------------------------------------
// One INSERT ... ON CONFLICT DO NOTHING plus one SELECT ... = ANY() resolves
// every new author (series, genre) in a whole batch of books, instead of two
// statements per name.

interface InternSpec {
  cache: Map<string, number>;
  insert: string;
  select: string;
  /** true when the table also carries search_* / lang_code columns to fill. */
  withLang: boolean;
}

const AUTHOR_INTERN: InternSpec = {
  cache: authorIds,
  insert: `INSERT INTO authors (full_name, search_full_name, lang_code)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
     ON CONFLICT (full_name) DO NOTHING`,
  select: 'SELECT id, full_name AS name FROM authors WHERE full_name = ANY($1::text[])',
  withLang: true,
};
const SERIES_INTERN: InternSpec = {
  cache: seriesIds,
  insert: `INSERT INTO series (ser, search_ser, lang_code)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
     ON CONFLICT (ser) DO NOTHING`,
  select: 'SELECT id, ser AS name FROM series WHERE ser = ANY($1::text[])',
  withLang: true,
};
const GENRE_INTERN: InternSpec = {
  cache: genreIds,
  insert: `INSERT INTO genres (genre, section, subsection)
     SELECT g, 'Unknown genre', LEFT(g, 100) FROM UNNEST($1::text[]) AS g
     ON CONFLICT (genre) DO NOTHING`,
  select: 'SELECT id, genre AS name FROM genres WHERE genre = ANY($1::text[])',
  withLang: false,
};

/** Resolve a batch of names to ids in two statements, caching the result.
 *  Names already in `spec.cache`, and a call with nothing new, are skipped -
 *  both are pure shortcuts over sending an empty UNNEST to Postgres. */
async function intern(cx: Query, names: string[], spec: InternSpec): Promise<void> {
  // Stryker disable next-line MethodExpression: re-interning a known name is a
  // harmless ON CONFLICT DO NOTHING; the filter only saves the round trip.
  const missing = [...new Set(names.filter((n) => !spec.cache.has(n)))];
  // Stryker disable next-line ConditionalExpression: an empty UNNEST inserts and
  // selects nothing, so skipping it here changes no state.
  if (!missing.length) return;
  const params = spec.withLang
    ? arr(missing, missing.map((n) => normalize(n)), missing.map((n) => getLangCode(n)))
    : arr(missing);
  await cx.run(spec.insert, params);
  const rows = await cx.all<{ id: number; name: string }>(spec.select, arr(missing));
  for (const r of rows) spec.cache.set(r.name, r.id);
}

export const internAuthors = (cx: Query, names: string[]): Promise<void> =>
  intern(cx, names, AUTHOR_INTERN);
export const internSeries = (cx: Query, names: string[]): Promise<void> =>
  intern(cx, names, SERIES_INTERN);
export const internGenres = (cx: Query, names: string[]): Promise<void> =>
  intern(cx, names, GENRE_INTERN);

// ---- bulk book insert -------------------------------------------------

export interface PendingBook {
  filename: string;
  relDir: string;
  catalogId: number;
  catType: number;
  filesize: number;
  meta: BookMeta;
  /** Where the entry sits in its archive; absent for loose files. */
  loc?: ZipLocation;
}

export const bookKey = (relDir: string, filename: string): string => `${relDir}\u0000${filename}`;

/** Insert a chunk of books and their links. Returns how many rows were
 *  genuinely new (the rest were already in the catalog). */
export async function insertBooks(cx: Query, rows: PendingBook[]): Promise<number> {
  // `ON CONFLICT DO UPDATE` cannot touch the same row twice in one statement,
  // so a duplicate (path, filename) inside the chunk has to go first.
  const byKey = new Map<string, PendingBook>();
  for (const r of rows) {
    const key = bookKey(r.relDir, r.filename);
    if (!byKey.has(key)) byKey.set(key, r);
  }
  const books = [...byKey.values()];
  // Stryker disable next-line ConditionalExpression: with no books every UNNEST
  // below is empty and the function returns 0 regardless; this is a shortcut.
  if (!books.length) return 0;

  await internAuthors(cx, books.flatMap((b) => b.meta.authors.map((a) => a.slice(0, 128))));
  await internGenres(cx, books.flatMap((b) => b.meta.genres.map((g) => g.slice(0, 32))));
  await internSeries(
    cx,
    books.flatMap((b) => (b.meta.series ? [b.meta.series.title.slice(0, 150)] : [])),
  );

  const written = await cx.all<{ id: number; path: string; filename: string; inserted: boolean }>(
    `INSERT INTO books (filename, path, filesize, format, catalog_id, cat_type,
        doc_date, lang, title, search_title, annotation, lang_code,
        zip_offset, zip_csize, zip_method, avail)
     SELECT *, 2 FROM UNNEST(
        $1::text[], $2::text[], $3::bigint[], $4::text[], $5::int[], $6::int[],
        $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::int[],
        $13::bigint[], $14::bigint[], $15::int[])
     ON CONFLICT (path, filename) DO UPDATE SET avail = 2,
        zip_offset = EXCLUDED.zip_offset,
        zip_csize  = EXCLUDED.zip_csize,
        zip_method = EXCLUDED.zip_method
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
      books.map((b) => b.loc?.offset ?? null),
      books.map((b) => b.loc?.csize ?? null),
      books.map((b) => b.loc?.method ?? null),
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
    // Stryker disable next-line ConditionalExpression: every book in `books` gets
    // a RETURNING row, so `id` is never actually undefined - this is a guard.
    if (id === undefined) continue;
    for (const a of b.meta.authors) {
      const aid = authorIds.get(a.slice(0, 128));
      // Stryker disable next-line ConditionalExpression: `intern` just ran for
      // every name, so `aid` is always set; a missing one would be a bug.
      if (aid !== undefined) {
        baBook.push(id);
        baAuthor.push(aid);
      }
    }
    for (const g of b.meta.genres) {
      const gid = genreIds.get(g.slice(0, 32));
      // Stryker disable next-line ConditionalExpression: as above - `gid` is set.
      if (gid !== undefined) {
        bgBook.push(id);
        bgGenre.push(gid);
      }
    }
    if (b.meta.series) {
      const sid = seriesIds.get(b.meta.series.title.slice(0, 150));
      // Stryker disable next-line ConditionalExpression: as above - `sid` is set.
      if (sid !== undefined) {
        bsBook.push(id);
        bsSer.push(sid);
        bsNo.push(b.meta.series.index || 0);
      }
    }
  }
  // DO NOTHING (unlike DO UPDATE) tolerates duplicates inside one statement,
  // so a book that lists the same author or genre twice needs no dedupe here.
  const link = (sql: string, ...cols: number[][]): Promise<unknown> =>
    // Stryker disable next-line ConditionalExpression: an empty UNNEST is a
    // no-op; the guard only saves the round trip.
    cols[0].length ? cx.run(sql, arr(...cols)) : Promise.resolve();
  await link(
    `INSERT INTO book_authors (book_id, author_id)
       SELECT * FROM UNNEST($1::int[], $2::int[]) ON CONFLICT DO NOTHING`,
    baBook,
    baAuthor,
  );
  await link(
    `INSERT INTO book_genres (book_id, genre_id)
       SELECT * FROM UNNEST($1::int[], $2::int[]) ON CONFLICT DO NOTHING`,
    bgBook,
    bgGenre,
  );
  await link(
    `INSERT INTO book_series (book_id, ser_id, ser_no)
       SELECT * FROM UNNEST($1::int[], $2::int[], $3::int[]) ON CONFLICT DO NOTHING`,
    bsBook,
    bsSer,
    bsNo,
  );
  return added;
}

// ---- the writer -------------------------------------------------------
// The scan commits every `batchSize` books rather than running as one
// transaction, so books are searchable while the rest of the collection is read.
// Concurrent readers queue their statements through `enqueue()`, so only one of
// them is inside the transaction at a time.

export class Writer {
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
    // Stryker disable next-line EqualityOperator: an extra i === length pass just
    // runs an empty UPDATE; the loop chunks 1000 at a time either way.
    for (let i = 0; i < filenames.length; i += 1000) {
      // Stryker disable next-line MethodExpression: the UPDATE is idempotent, so
      // widening each chunk to the whole list only repeats work, same result.
      const slice = filenames.slice(i, i + 1000) as unknown as SqlParam;
      await this.serial((cx) =>
        cx.run('UPDATE books SET avail = 2 WHERE path = $1 AND filename = ANY($2::text[])', [
          relPath,
          slice,
        ]),
      );
    }
  }

  /**
   * Re-mark known entries of an archive we are re-reading, and refresh where
   * they live: the archive changed since the last scan, so recorded offsets
   * cannot be trusted even for entries whose metadata we are not re-parsing.
   */
  async markSeenAt(relPath: string, seen: { name: string; loc: ZipLocation }[]): Promise<void> {
    // Stryker disable next-line EqualityOperator: as markSeen - an extra empty pass.
    for (let i = 0; i < seen.length; i += 1000) {
      // Stryker disable next-line MethodExpression: as markSeen - idempotent UPDATE.
      const slice = seen.slice(i, i + 1000);
      await this.serial((cx) =>
        cx.run(
          `UPDATE books b SET avail = 2, zip_offset = u.off,
              zip_csize = u.csize, zip_method = u.method
           FROM UNNEST($2::text[], $3::bigint[], $4::bigint[], $5::int[])
                AS u(name, off, csize, method)
           WHERE b.path = $1 AND b.filename = u.name`,
          [
            relPath,
            ...arr(
              slice.map((e) => e.name),
              slice.map((e) => e.loc.offset),
              slice.map((e) => e.loc.csize),
              slice.map((e) => e.loc.method),
            ),
          ],
        ),
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
    // Read the counter *after* the await: `this.added += await …` would capture
    // the old value first, and with concurrent readers a second chunk finishing
    // in between would then overwrite this one's increment.
    const inserted = await this.serial((cx) => insertBooks(cx, rows));
    this.added += inserted;
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

/** Read from disk only what this format's parser will actually look at. */
export async function readLooseForMeta(abs: string, filename: string, size: number): Promise<Buffer> {
  const plan = metaReadPlan(filename);
  if (plan.need === 'none') return NO_BYTES;
  if (plan.need === 'all') return fsp.readFile(abs);
  const want = Math.min(size, plan.limit);
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The same, for an entry inside an archive: a head read stops the inflater
 *  early, and a format we cannot introspect is never inflated at all. */
export function readEntryForMeta(entry: ZipEntry, filename: string): Promise<Buffer> {
  const plan = metaReadPlan(filename);
  if (plan.need === 'none') return Promise.resolve(NO_BYTES);
  if (plan.need === 'all') return entry.read();
  return entry.readHead(plan.limit, plan.stopAt);
}

// ---- the walk ---------------------------------------------------------

export type Task = { kind: 'dir'; abs: string; files: string[] } | { kind: 'zip'; abs: string };

/** Yield one unit of work at a time so a huge tree is never fully listed. */
export function* tasks(dir: string, ctx: ScanCtx): Generator<Task> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files: string[] = [];
  // Stryker disable next-line ArrayDeclaration: a bogus seed entry recurses into
  // a path that does not exist, which readdirSync swallows - no yielded task.
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      subdirs.push(path.join(dir, entry.name));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === '.zip') {
      if (ctx.zipScan) yield { kind: 'zip', abs: path.join(dir, entry.name) };
      continue;
    }
    if (ctx.bookExtensions.includes(ext)) files.push(entry.name);
  }
  if (files.length) yield { kind: 'dir', abs: dir, files };
  for (const sub of subdirs) yield* tasks(sub, ctx);
}

/** Run `fn` over the generator with at most `n` tasks in flight. */
export async function pool<T>(
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
  // Stryker disable next-line MethodExpression: re-reading a known file just
  // re-runs an idempotent ON CONFLICT upsert - the filter only saves the work.
  const fresh = task.files.filter((f) => !known.has(f));
  // Stryker disable next-line ConditionalExpression: with nothing seen the body
  // is markSeen([]) + `+= 0` + progressed(0), all no-ops.
  if (seen.length) {
    await writer.markSeen(relDir, seen);
    stats.skipped += seen.length;
    await writer.progressed(seen.length);
  }
  // Stryker disable next-line ConditionalExpression: with nothing fresh the rest
  // is one idempotent addCatTree and a loop over an empty list.
  if (!fresh.length) return;

  const catalogId = await writer.catalog(relDir, CAT_NORMAL);
  for (const filename of fresh) {
    const abs = path.join(task.abs, filename);
    try {
      const size = (await fsp.stat(abs)).size;
      const buf = await readLooseForMeta(abs, filename, size);
      await writer.add({
        filename,
        relDir,
        catalogId,
        catType: CAT_NORMAL,
        filesize: size,
        // Stryker disable next-line ObjectLiteral,BooleanLiteral: metaOnly only
        // skips cover decoding, which the scan discards anyway - same metadata.
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
  ctx: ScanCtx,
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
  const seen: { name: string; loc: ZipLocation }[] = [];

  try {
    for await (const entry of zipEntries(abs)) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!ctx.bookExtensions.includes(ext)) continue;
      const loc: ZipLocation = { offset: entry.offset, csize: entry.csize, method: entry.method };
      if (known.has(entry.name)) {
        seen.push({ name: entry.name, loc });
        stats.skipped++;
        continue;
      }
      try {
        const buf = await readEntryForMeta(entry, entry.name);
        await writer.add({
          filename: entry.name,
          relDir: relZip,
          catalogId,
          catType: CAT_ZIP,
          filesize: entry.size,
          // Stryker disable next-line ObjectLiteral,BooleanLiteral: as above -
          // metaOnly changes only cover decoding, which the scan ignores.
          meta: parseBook(buf, path.basename(entry.name), { metaOnly: true }),
          loc,
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
    // Stryker disable next-line ConditionalExpression: markSeenAt([]) +
    // progressed(0) are no-ops, so the guard only skips a wasted statement.
    if (seen.length) {
      await writer.markSeenAt(relZip, seen);
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
  const ctx = buildCtx();
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

  // Mark everything pending; the walk re-marks what it finds and the final sweep
  // deletes the rest. Its own commit, and avail = 1 still reads as available.
  await db.run('UPDATE books SET avail = 1 WHERE avail <> 0');

  const refreshCounters = makeCounterGate(updateCounters);
  const writer = new Writer(batchSize, async () => {
    stats.added = writer.added;
    await refreshCounters();
    log(`  ... ${writer.added} books added so far`);
    onProgress?.({ added: stats.added, skipped: stats.skipped });
  });

  try {
    await pool(tasks(rootDir, ctx), ctx.concurrency, (task) =>
      task.kind === 'zip'
        ? processZip(writer, task.abs, rootDir, ctx, stats, log)
        : processDir(writer, task, rootDir, stats, log),
    );
    await writer.flush();
  } catch (err) {
    await writer.abort();
    throw err;
  }
  stats.added = writer.added;

  if (ctx.deleteMissing) {
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
export function scanConcurrency(get: Setting = setting): number {
  const configured = Number(get('scanConcurrency')) || 0;
  if (configured > 0) return Math.min(configured, 64);
  return Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length));
}
