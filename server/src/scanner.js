import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import db, { updateCounters } from './db.js';
import config from './config.js';
import { parseBook } from './books/index.js';
import { normalize, getLangCode } from './lang.js';

const CAT_NORMAL = 0;
const CAT_ZIP = 1;

// ---- prepared statements -------------------------------------------------
const S = {
  findCat: db.prepare('SELECT * FROM catalogs WHERE path = ?'),
  insertCat: db.prepare(
    'INSERT INTO catalogs (parent_id, cat_name, path, cat_type, cat_size) VALUES (?, ?, ?, ?, ?)',
  ),
  findBook: db.prepare('SELECT * FROM books WHERE path = ? AND filename = ?'),
  setAvail: db.prepare('UPDATE books SET avail = ? WHERE id = ?'),
  insertBook: db.prepare(
    `INSERT INTO books (filename, path, filesize, format, catalog_id, cat_type,
        doc_date, lang, title, search_title, annotation, lang_code, avail)
     VALUES (@filename, @path, @filesize, @format, @catalog_id, @cat_type,
        @doc_date, @lang, @title, @search_title, @annotation, @lang_code, 2)`,
  ),
  findAuthor: db.prepare('SELECT id FROM authors WHERE full_name = ?'),
  insertAuthor: db.prepare(
    'INSERT INTO authors (full_name, search_full_name, lang_code) VALUES (?, ?, ?)',
  ),
  findSeries: db.prepare('SELECT id FROM series WHERE ser = ?'),
  insertSeries: db.prepare(
    'INSERT INTO series (ser, search_ser, lang_code) VALUES (?, ?, ?)',
  ),
  findGenre: db.prepare('SELECT id FROM genres WHERE genre = ?'),
  insertGenre: db.prepare(
    "INSERT INTO genres (genre, section, subsection) VALUES (?, 'Unknown genre', ?)",
  ),
  linkAuthor: db.prepare(
    'INSERT OR IGNORE INTO book_authors (book_id, author_id) VALUES (?, ?)',
  ),
  linkGenre: db.prepare(
    'INSERT OR IGNORE INTO book_genres (book_id, genre_id) VALUES (?, ?)',
  ),
  linkSeries: db.prepare(
    'INSERT OR IGNORE INTO book_series (book_id, ser_id, ser_no) VALUES (?, ?, ?)',
  ),
  availPrepare: db.prepare('UPDATE books SET avail = 1 WHERE avail <> 0'),
  deleteGone: db.prepare('DELETE FROM books WHERE avail <= 1'),
};

function addCatTree(relPath, catType = CAT_NORMAL, size = 0) {
  if (!relPath || relPath === '.' || relPath === '') {
    const existing = S.findCat.get('.');
    if (existing) return existing.id;
    return Number(S.insertCat.run(null, '.', '.', 0, 0).lastInsertRowid);
  }
  const existing = S.findCat.get(relPath);
  if (existing) return existing.id;
  const parent = path.dirname(relPath);
  const parentId = addCatTree(parent === relPath ? '.' : parent);
  return Number(
    S.insertCat.run(parentId, path.basename(relPath), relPath, catType, size)
      .lastInsertRowid,
  );
}

function getOrCreateAuthor(fullName) {
  const name = fullName.slice(0, 128);
  const found = S.findAuthor.get(name);
  if (found) return found.id;
  return Number(
    S.insertAuthor.run(name, normalize(name), getLangCode(name)).lastInsertRowid,
  );
}

function getOrCreateSeries(ser) {
  const name = ser.slice(0, 150);
  const found = S.findSeries.get(name);
  if (found) return found.id;
  return Number(
    S.insertSeries.run(name, normalize(name), getLangCode(name)).lastInsertRowid,
  );
}

function getOrCreateGenre(genre) {
  const g = genre.slice(0, 32);
  const found = S.findGenre.get(g);
  if (found) return found.id;
  return Number(S.insertGenre.run(g, g.slice(0, 100)).lastInsertRowid);
}

function addBook({ filename, relDir, catalogId, catType, filesize, meta }) {
  const info = {
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
  };
  const bookId = Number(S.insertBook.run(info).lastInsertRowid);
  for (const a of meta.authors) S.linkAuthor.run(bookId, getOrCreateAuthor(a));
  for (const g of meta.genres) S.linkGenre.run(bookId, getOrCreateGenre(g));
  if (meta.series)
    S.linkSeries.run(
      bookId,
      getOrCreateSeries(meta.series.title),
      meta.series.index || 0,
    );
  return bookId;
}

export function scan({ log = console.log } = {}) {
  const root = config.rootLib;
  if (!fs.existsSync(root)) {
    log(`Book collection directory not found: ${root}`);
    return { added: 0, skipped: 0, removed: 0, bad: 0 };
  }
  const stats = { added: 0, skipped: 0, removed: 0, bad: 0, archives: 0 };
  const tx = db.transaction(() => {
    S.availPrepare.run();
    walk(root, root, stats, log);
    stats.removed = S.deleteGone.run().changes;
  });
  tx();
  updateCounters();
  log(
    `Scan done. added=${stats.added} skipped=${stats.skipped} removed=${stats.removed} bad=${stats.bad} archives=${stats.archives}`,
  );
  return stats;
}

function walk(dir, root, stats, log) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, root, stats, log);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === '.zip') {
      if (config.zipScan) processZip(abs, root, stats, log);
      continue;
    }
    if (!config.bookExtensions.includes(ext)) continue;
    processFile(abs, root, stats, log);
  }
}

function processFile(abs, root, stats, log) {
  const relDir = path.relative(root, path.dirname(abs)) || '.';
  const filename = path.basename(abs);
  const existing = S.findBook.get(relDir, filename);
  if (existing) {
    S.setAvail.run(2, existing.id);
    stats.skipped++;
    return;
  }
  try {
    const buf = fs.readFileSync(abs);
    const meta = parseBook(buf, filename);
    const catalogId = addCatTree(relDir, CAT_NORMAL);
    addBook({
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
    log(`  bad book ${relDir}/${filename}: ${err.message}`);
  }
}

function processZip(abs, root, stats, log) {
  const relZip = path.relative(root, abs);
  const size = fs.statSync(abs).size;
  const existingCat = S.findCat.get(relZip);
  if (existingCat && existingCat.cat_size === size) {
    // Archive unchanged: keep its books.
    db.prepare('UPDATE books SET avail = 2 WHERE path = ?').run(relZip);
    stats.skipped++;
    return;
  }
  let zip;
  try {
    zip = new AdmZip(abs);
  } catch {
    stats.bad++;
    log(`  bad archive ${relZip}`);
    return;
  }
  const catalogId = addCatTree(relZip, CAT_ZIP, size);
  db.prepare('UPDATE catalogs SET cat_size = ? WHERE id = ?').run(
    size,
    catalogId,
  );
  stats.archives++;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (!config.bookExtensions.includes(ext)) continue;
    const filename = entry.entryName;
    const existing = S.findBook.get(relZip, filename);
    if (existing) {
      S.setAvail.run(2, existing.id);
      stats.skipped++;
      continue;
    }
    try {
      const buf = entry.getData();
      const meta = parseBook(buf, path.basename(filename));
      addBook({
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
      log(`  bad book ${relZip}!${filename}: ${err.message}`);
    }
  }
}
