import fs from 'node:fs';
import path from 'node:path';
import db, { updateCounters } from '../db.js';
import type { Query, Tx } from '../db.js';
import { get as setting } from '../settings.js';
import { parseBook } from '../books/index.js';
import { normalize, getLangCode } from '../lang.js';
import { zipEntries } from '../zip.js';
import type { BookMeta, ScanStats } from '../types.js';

// The collection walk: the raw, unguarded Scan operation. `runOnce()` is called
// directly by the CLI (`bin/scan.ts`) and the tests; the server reaches it only
// through the Scanner module (`scan/index.ts`), which adds the concurrency
// mutex, scheduling and folder-watch on top.

type LogFn = (msg: string) => void;
interface ScanCtx {
  bookExtensions: string[];
  zipScan: boolean;
  deleteMissing: boolean;
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

// Populated at the start of each runOnce() from the current settings.
let CTX: ScanCtx = { bookExtensions: [], zipScan: true, deleteMissing: true };

// ---- name → id caches -------------------------------------------------
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

// ---- batched writer --------------------------------------------------
// The scan does not run in one transaction. Instead it commits every
// `batchSize` books so they become searchable/downloadable while the rest of
// the collection is still being read. Each book's own inserts always share one
// transaction (a flush only happens between books).

class Batch {
  private tx: Tx | null = null;
  private sinceFlush = 0;
  added = 0;

  constructor(
    private readonly batchSize: number,
    private readonly onFlush: () => Promise<void>,
  ) {}

  /** The transaction current work should be written to. */
  async cx(): Promise<Query> {
    if (!this.tx) this.tx = await db.begin();
    return this.tx;
  }

  /** Count one processed book (added or re-seen) and flush if the batch is full. */
  async progressed(added: boolean): Promise<void> {
    if (added) this.added++;
    if (++this.sinceFlush >= this.batchSize) await this.flush();
  }

  /** Commit whatever is pending and publish it. */
  async flush(): Promise<void> {
    const hadWork = this.sinceFlush > 0;
    if (this.tx) {
      await this.tx.commit();
      this.tx = null;
    }
    if (hadWork) {
      this.sinceFlush = 0;
      await this.onFlush();
    }
  }

  /** Discard the in-flight batch (caches may now be stale, so drop them). */
  async abort(): Promise<void> {
    if (this.tx) {
      await this.tx.rollback();
      this.tx = null;
    }
    resetCaches();
  }
}

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

async function getOrCreateAuthor(cx: Query, fullName: string): Promise<number> {
  const name = fullName.slice(0, 128);
  const cached = authorIds.get(name);
  if (cached !== undefined) return cached;
  const found = await cx.get<{ id: number }>('SELECT id FROM authors WHERE full_name = ?', [name]);
  const id =
    found?.id ??
    (await cx.get<{ id: number }>(
      `INSERT INTO authors (full_name, search_full_name, lang_code)
       VALUES (?, ?, ?) RETURNING id`,
      [name, normalize(name), getLangCode(name)],
    ))!.id;
  authorIds.set(name, id);
  return id;
}

async function getOrCreateSeries(cx: Query, ser: string): Promise<number> {
  const name = ser.slice(0, 150);
  const cached = seriesIds.get(name);
  if (cached !== undefined) return cached;
  const found = await cx.get<{ id: number }>('SELECT id FROM series WHERE ser = ?', [name]);
  const id =
    found?.id ??
    (await cx.get<{ id: number }>(
      `INSERT INTO series (ser, search_ser, lang_code) VALUES (?, ?, ?) RETURNING id`,
      [name, normalize(name), getLangCode(name)],
    ))!.id;
  seriesIds.set(name, id);
  return id;
}

async function getOrCreateGenre(cx: Query, genre: string): Promise<number> {
  const g = genre.slice(0, 32);
  const cached = genreIds.get(g);
  if (cached !== undefined) return cached;
  const found = await cx.get<{ id: number }>('SELECT id FROM genres WHERE genre = ?', [g]);
  const id =
    found?.id ??
    (await cx.get<{ id: number }>(
      `INSERT INTO genres (genre, section, subsection)
       VALUES (?, 'Unknown genre', ?) RETURNING id`,
      [g, g.slice(0, 100)],
    ))!.id;
  genreIds.set(g, id);
  return id;
}

interface AddBookArgs {
  filename: string;
  relDir: string;
  catalogId: number;
  catType: number;
  filesize: number;
  meta: BookMeta;
}

async function addBook(
  cx: Query,
  { filename, relDir, catalogId, catType, filesize, meta }: AddBookArgs,
): Promise<number> {
  const row = await cx.get<{ id: number }>(
    `INSERT INTO books (filename, path, filesize, format, catalog_id, cat_type,
        doc_date, lang, title, search_title, annotation, lang_code, avail)
     VALUES (@filename, @path, @filesize, @format, @catalog_id, @cat_type,
        @doc_date, @lang, @title, @search_title, @annotation, @lang_code, 2)
     RETURNING id`,
    {
      filename,
      path: relDir,
      filesize,
      format: meta.format,
      catalog_id: catalogId,
      cat_type: catType,
      doc_date: meta.docdate || '',
      lang: meta.lang || '',
      title: meta.title,
      search_title: normalize(meta.title),
      annotation: meta.annotation || '',
      lang_code: meta.langCode,
    },
  );
  const bookId = row!.id;
  for (const a of meta.authors) {
    await cx.run(
      'INSERT INTO book_authors (book_id, author_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [bookId, await getOrCreateAuthor(cx, a)],
    );
  }
  for (const g of meta.genres) {
    await cx.run(
      'INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [bookId, await getOrCreateGenre(cx, g)],
    );
  }
  if (meta.series) {
    await cx.run(
      'INSERT INTO book_series (book_id, ser_id, ser_no) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [bookId, await getOrCreateSeries(cx, meta.series.title), meta.series.index || 0],
    );
  }
  return bookId;
}

export interface RunOnceOpts {
  log?: LogFn;
  /** Called after every committed batch with the running added/skipped totals. */
  onProgress?: (p: { added: number; skipped: number }) => void;
}

export async function runOnce({ log = console.log, onProgress }: RunOnceOpts = {}): Promise<ScanStats> {
  const rootDir = setting('rootLib');
  CTX = {
    bookExtensions: setting('bookExtensions')
      .split(/\s+/)
      .filter(Boolean)
      .map((e) => e.toLowerCase()),
    zipScan: setting('zipScan'),
    deleteMissing: setting('deleteMissing'),
  };
  if (!fs.existsSync(rootDir)) {
    log(`Book collection directory not found: ${rootDir}`);
    return { added: 0, skipped: 0, removed: 0, bad: 0, archives: 0, error: 'collection directory not found' };
  }

  const batchSize = Math.max(1, Number(setting('scanBatchSize')) || 10000);
  const stats: WalkStats = { added: 0, skipped: 0, removed: 0, bad: 0, archives: 0 };
  resetCaches();

  // Mark everything unavailable-pending; the walk re-marks what it finds and the
  // sweep at the end deletes what it never saw. This is its own commit so books
  // stay visible (avail = 1 is still "available") while the batches land.
  await db.run('UPDATE books SET avail = 1 WHERE avail <> 0');

  const batch = new Batch(batchSize, async () => {
    await updateCounters();
    log(`  … ${batch.added} books added so far`);
    onProgress?.({ added: stats.added, skipped: stats.skipped });
  });

  try {
    await walk(batch, rootDir, rootDir, stats, log);
    await batch.flush();
  } catch (err) {
    await batch.abort();
    throw err;
  }

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

async function walk(
  batch: Batch,
  dir: string,
  root: string,
  stats: WalkStats,
  log: LogFn,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(batch, abs, root, stats, log);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === '.zip') {
      if (CTX.zipScan) await processZip(batch, abs, root, stats, log);
      continue;
    }
    if (!CTX.bookExtensions.includes(ext)) continue;
    await processFile(batch, abs, root, stats, log);
  }
}

async function processFile(
  batch: Batch,
  abs: string,
  root: string,
  stats: WalkStats,
  log: LogFn,
): Promise<void> {
  const relDir = path.relative(root, path.dirname(abs)) || '.';
  const filename = path.basename(abs);
  const cx = await batch.cx();
  const existing = await cx.get<{ id: number }>(
    'SELECT id FROM books WHERE path = ? AND filename = ?',
    [relDir, filename],
  );
  if (existing) {
    await cx.run('UPDATE books SET avail = 2 WHERE id = ?', [existing.id]);
    stats.skipped++;
    await batch.progressed(false);
    return;
  }
  try {
    const buf = fs.readFileSync(abs);
    const meta = parseBook(buf, filename);
    const catalogId = await addCatTree(cx, relDir, CAT_NORMAL);
    await addBook(cx, {
      filename,
      relDir,
      catalogId,
      catType: CAT_NORMAL,
      filesize: buf.length,
      meta,
    });
    stats.added++;
    await batch.progressed(true);
  } catch (err) {
    stats.bad++;
    log(`  bad book ${relDir}/${filename}: ${(err as Error).message}`);
  }
}

async function processZip(
  batch: Batch,
  abs: string,
  root: string,
  stats: WalkStats,
  log: LogFn,
): Promise<void> {
  const relZip = path.relative(root, abs);
  const size = fs.statSync(abs).size;
  const cx0 = await batch.cx();
  const existingCat = await cx0.get<{ cat_size: number }>(
    'SELECT * FROM catalogs WHERE path = ?',
    [relZip],
  );
  if (existingCat && Number(existingCat.cat_size) === size) {
    // Archive unchanged since the last scan: keep its books, read nothing.
    await cx0.run('UPDATE books SET avail = 2 WHERE path = ?', [relZip]);
    stats.skipped++;
    await batch.progressed(false);
    return;
  }

  let catalogId: number | null = null;
  // Create/locate the archive's catalog row lazily on the first entry. Its
  // `cat_size` is the "fully scanned" marker and is only written once the whole
  // archive has been read (below), so a scan interrupted mid-archive re-reads it
  // next time instead of trusting a half-populated catalog.
  const ensureCatalog = async (): Promise<{ cx: Query; id: number }> => {
    const cx = await batch.cx();
    if (catalogId === null) {
      catalogId = await addCatTree(cx, relZip, CAT_ZIP, 0);
      await cx.run('UPDATE catalogs SET cat_size = 0 WHERE id = ?', [catalogId]);
      stats.archives++;
    }
    return { cx, id: catalogId };
  };

  try {
    for await (const entry of zipEntries(abs)) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!CTX.bookExtensions.includes(ext)) continue;
      const filename = entry.name;
      // A flush may have happened on the previous entry, so re-fetch the tx.
      const { cx, id: catId } = await ensureCatalog();
      const existing = await cx.get<{ id: number }>(
        'SELECT id FROM books WHERE path = ? AND filename = ?',
        [relZip, filename],
      );
      if (existing) {
        await cx.run('UPDATE books SET avail = 2 WHERE id = ?', [existing.id]);
        stats.skipped++;
        await batch.progressed(false);
        continue;
      }
      try {
        const buf = await entry.read();
        const meta = parseBook(buf, path.basename(filename));
        await addBook(cx, {
          filename,
          relDir: relZip,
          catalogId: catId,
          catType: CAT_ZIP,
          filesize: buf.length,
          meta,
        });
        stats.added++;
        await batch.progressed(true);
      } catch (err) {
        stats.bad++;
        log(`  bad book ${relZip}!${filename}: ${(err as Error).message}`);
      }
    }
    // Whole archive read: stamp its size as the "fully scanned" marker so the
    // next scan skips it. (Also covers a valid archive that held no books.)
    const { cx, id } = await ensureCatalog();
    await cx.run('UPDATE catalogs SET cat_size = ? WHERE id = ?', [size, id]);
  } catch (err) {
    stats.bad++;
    log(`  bad archive ${relZip}: ${(err as Error).message}`);
  }
}
