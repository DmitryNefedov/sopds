import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import db, { updateCounters } from './db.js';
import { get as setting } from './settings.js';
import { parseBook } from './books/index.js';
import { normalize, getLangCode } from './lang.js';
import type { Query } from './db.js';
import type { BookMeta, ScanStats } from './types.js';

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

// Populated at the start of each scan() from the current settings.
let CTX: ScanCtx = { bookExtensions: [], zipScan: true, deleteMissing: true };

// ---- per-transaction query helpers -------------------------------------
// `cx` is the transaction-bound query API from db.tx().

async function addCatTree(
  cx: Query,
  relPath: string,
  catType = CAT_NORMAL,
  size = 0,
): Promise<number> {
  if (!relPath || relPath === '.' || relPath === '') {
    const existing = await cx.get<{ id: number }>('SELECT id FROM catalogs WHERE path = ?', ['.']);
    if (existing) return existing.id;
    const row = await cx.get<{ id: number }>(
      `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size)
       VALUES (NULL, '.', '.', 0, 0) RETURNING id`,
    );
    return row!.id;
  }
  const existing = await cx.get<{ id: number }>('SELECT id FROM catalogs WHERE path = ?', [relPath]);
  if (existing) return existing.id;
  const parent = path.dirname(relPath);
  const parentId = await addCatTree(cx, parent === relPath ? '.' : parent);
  const row = await cx.get<{ id: number }>(
    `INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [parentId, path.basename(relPath), relPath, catType, size],
  );
  return row!.id;
}

async function getOrCreateAuthor(cx: Query, fullName: string): Promise<number> {
  const name = fullName.slice(0, 128);
  const found = await cx.get<{ id: number }>('SELECT id FROM authors WHERE full_name = ?', [name]);
  if (found) return found.id;
  const row = await cx.get<{ id: number }>(
    `INSERT INTO authors (full_name, search_full_name, lang_code)
     VALUES (?, ?, ?) RETURNING id`,
    [name, normalize(name), getLangCode(name)],
  );
  return row!.id;
}

async function getOrCreateSeries(cx: Query, ser: string): Promise<number> {
  const name = ser.slice(0, 150);
  const found = await cx.get<{ id: number }>('SELECT id FROM series WHERE ser = ?', [name]);
  if (found) return found.id;
  const row = await cx.get<{ id: number }>(
    `INSERT INTO series (ser, search_ser, lang_code) VALUES (?, ?, ?) RETURNING id`,
    [name, normalize(name), getLangCode(name)],
  );
  return row!.id;
}

async function getOrCreateGenre(cx: Query, genre: string): Promise<number> {
  const g = genre.slice(0, 32);
  const found = await cx.get<{ id: number }>('SELECT id FROM genres WHERE genre = ?', [g]);
  if (found) return found.id;
  const row = await cx.get<{ id: number }>(
    `INSERT INTO genres (genre, section, subsection)
     VALUES (?, 'Unknown genre', ?) RETURNING id`,
    [g, g.slice(0, 100)],
  );
  return row!.id;
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

export interface ScanOpts {
  log?: LogFn;
  root?: string;
}

export async function scan({ log = console.log, root }: ScanOpts = {}): Promise<ScanStats> {
  const rootDir = root || setting('rootLib');
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
  const stats: WalkStats = { added: 0, skipped: 0, removed: 0, bad: 0, archives: 0 };
  await db.tx(async (cx) => {
    await cx.run('UPDATE books SET avail = 1 WHERE avail <> 0');
    await walk(cx, rootDir, rootDir, stats, log);
    if (CTX.deleteMissing) {
      const r = await cx.run('DELETE FROM books WHERE avail <= 1');
      stats.removed = r.rowCount;
    }
  });
  await updateCounters();
  log(
    `Scan done. added=${stats.added} skipped=${stats.skipped} removed=${stats.removed} bad=${stats.bad} archives=${stats.archives}`,
  );
  return stats;
}

async function walk(
  cx: Query,
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
      await walk(cx, abs, root, stats, log);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === '.zip') {
      if (CTX.zipScan) await processZip(cx, abs, root, stats, log);
      continue;
    }
    if (!CTX.bookExtensions.includes(ext)) continue;
    await processFile(cx, abs, root, stats, log);
  }
}

async function processFile(
  cx: Query,
  abs: string,
  root: string,
  stats: WalkStats,
  log: LogFn,
): Promise<void> {
  const relDir = path.relative(root, path.dirname(abs)) || '.';
  const filename = path.basename(abs);
  const existing = await cx.get<{ id: number }>(
    'SELECT id FROM books WHERE path = ? AND filename = ?',
    [relDir, filename],
  );
  if (existing) {
    await cx.run('UPDATE books SET avail = 2 WHERE id = ?', [existing.id]);
    stats.skipped++;
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
  } catch (err) {
    stats.bad++;
    log(`  bad book ${relDir}/${filename}: ${(err as Error).message}`);
  }
}

async function processZip(
  cx: Query,
  abs: string,
  root: string,
  stats: WalkStats,
  log: LogFn,
): Promise<void> {
  const relZip = path.relative(root, abs);
  const size = fs.statSync(abs).size;
  const existingCat = await cx.get<{ cat_size: number }>('SELECT * FROM catalogs WHERE path = ?', [relZip]);
  if (existingCat && Number(existingCat.cat_size) === size) {
    // Archive unchanged: keep its books.
    await cx.run('UPDATE books SET avail = 2 WHERE path = ?', [relZip]);
    stats.skipped++;
    return;
  }
  let zip: AdmZip;
  try {
    zip = new AdmZip(abs);
  } catch {
    stats.bad++;
    log(`  bad archive ${relZip}`);
    return;
  }
  const catalogId = await addCatTree(cx, relZip, CAT_ZIP, size);
  await cx.run('UPDATE catalogs SET cat_size = ? WHERE id = ?', [size, catalogId]);
  stats.archives++;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (!CTX.bookExtensions.includes(ext)) continue;
    const filename = entry.entryName;
    const existing = await cx.get<{ id: number }>(
      'SELECT id FROM books WHERE path = ? AND filename = ?',
      [relZip, filename],
    );
    if (existing) {
      await cx.run('UPDATE books SET avail = 2 WHERE id = ?', [existing.id]);
      stats.skipped++;
      continue;
    }
    try {
      const buf = entry.getData();
      const meta = parseBook(buf, path.basename(filename));
      await addBook(cx, {
        filename,
        relDir: relZip,
        catalogId,
        catType: CAT_ZIP,
        filesize: buf.length,
        meta,
      });
      stats.added++;
    } catch (err) {
      stats.bad++;
      log(`  bad book ${relZip}!${filename}: ${(err as Error).message}`);
    }
  }
}
