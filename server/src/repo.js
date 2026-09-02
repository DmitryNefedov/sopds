import db from './db.js';
import { S } from './settings.js';
import { normalize } from './lang.js';

const clampPage = (p) => {
  const n = Number.parseInt(p, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

const clampLimit = (l) => {
  const n = Number.parseInt(l, 10);
  if (!Number.isFinite(n) || n <= 0) return S.maxItems;
  return Math.min(n, 200);
};

// ---- hydration helpers -----------------------------------------------------

const authorsStmt = db.prepare(
  `SELECT a.id, a.full_name FROM authors a
   JOIN book_authors ba ON ba.author_id = a.id
   WHERE ba.book_id = ? ORDER BY a.full_name`,
);
const genresStmt = db.prepare(
  `SELECT g.id, g.genre, g.section, g.subsection FROM genres g
   JOIN book_genres bg ON bg.genre_id = g.id
   WHERE bg.book_id = ? ORDER BY g.subsection`,
);
const seriesStmt = db.prepare(
  `SELECT s.id, s.ser, bs.ser_no FROM series s
   JOIN book_series bs ON bs.ser_id = s.id
   WHERE bs.book_id = ? ORDER BY bs.ser_no`,
);

export function hydrateBook(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    path: row.path,
    format: row.format,
    filesize: row.filesize,
    cat_type: row.cat_type,
    lang: row.lang,
    lang_code: row.lang_code,
    doc_date: row.doc_date,
    register_date: row.register_date,
    annotation: stripTags(row.annotation || ''),
    catalog_id: row.catalog_id,
    authors: authorsStmt.all(row.id),
    genres: genresStmt.all(row.id),
    series: seriesStmt.all(row.id),
  };
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '').trim();
}

function paginate(page, limit) {
  const p = clampPage(page);
  const l = clampLimit(limit);
  return { page: p, limit: l, offset: (p - 1) * l };
}

function pageMeta(total, page, limit) {
  return {
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    has_next: page * limit < total,
    has_prev: page > 1,
  };
}

// ---- unified search ------------------------------------------------------

// A book matches when the query hits its title, ANY of its authors, or ANY of
// its series. This is the cross-entity "one query" search.
const BOOK_MATCH_FROM = `
  FROM books b
  LEFT JOIN book_authors ba ON ba.book_id = b.id
  LEFT JOIN authors a ON a.id = ba.author_id
  LEFT JOIN book_series bs ON bs.book_id = b.id
  LEFT JOIN series s ON s.id = bs.ser_id
  WHERE b.avail <> 0
    AND (b.search_title LIKE @like OR a.search_full_name LIKE @like OR s.search_ser LIKE @like)
`;

export function searchBooks(q, { page = 1, limit } = {}) {
  const like = `%${normalize(q)}%`;
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = db
    .prepare(`SELECT COUNT(DISTINCT b.id) c ${BOOK_MATCH_FROM}`)
    .get({ like }).c;
  const rows = db
    .prepare(
      `SELECT DISTINCT b.* ${BOOK_MATCH_FROM}
       ORDER BY b.search_title, b.doc_date DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ like, limit: l, offset });
  let items = rows.map(hydrateBook);
  if (S.doublesHide) items = hideDoubles(items);
  return { items, ...pageMeta(total, p, l) };
}

export function searchAuthors(q, { page = 1, limit } = {}) {
  const like = `%${normalize(q)}%`;
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = db
    .prepare('SELECT COUNT(*) c FROM authors WHERE search_full_name LIKE ?')
    .get(like).c;
  const rows = db
    .prepare(
      `SELECT a.id, a.full_name, a.lang_code,
              (SELECT COUNT(*) FROM book_authors ba WHERE ba.author_id = a.id) AS book_count
       FROM authors a
       WHERE a.search_full_name LIKE @like
       ORDER BY a.search_full_name
       LIMIT @limit OFFSET @offset`,
    )
    .all({ like, limit: l, offset });
  return { items: rows, ...pageMeta(total, p, l) };
}

export function searchSeries(q, { page = 1, limit } = {}) {
  const like = `%${normalize(q)}%`;
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = db
    .prepare('SELECT COUNT(*) c FROM series WHERE search_ser LIKE ?')
    .get(like).c;
  const rows = db
    .prepare(
      `SELECT s.id, s.ser, s.lang_code,
              (SELECT COUNT(*) FROM book_series bs WHERE bs.ser_id = s.id) AS book_count
       FROM series s
       WHERE s.search_ser LIKE @like
       ORDER BY s.search_ser
       LIMIT @limit OFFSET @offset`,
    )
    .all({ like, limit: l, offset });
  return { items: rows, ...pageMeta(total, p, l) };
}

// Combined overview: a preview of each entity type for a single query.
export function searchAll(q, { previewLimit = 5 } = {}) {
  return {
    query: q,
    authors: searchAuthors(q, { page: 1, limit: previewLimit }),
    series: searchSeries(q, { page: 1, limit: previewLimit }),
    books: searchBooks(q, { page: 1, limit: previewLimit }),
  };
}

function hideDoubles(items) {
  const out = [];
  let prevTitle = null;
  let prevAuthors = null;
  for (const b of items) {
    const key = b.title.toUpperCase();
    const authorSet = b.authors
      .map((a) => a.id)
      .sort()
      .join(',');
    if (key === prevTitle && authorSet === prevAuthors) {
      out[out.length - 1].doubles = (out[out.length - 1].doubles || 0) + 1;
    } else {
      out.push({ ...b, doubles: 0 });
    }
    prevTitle = key;
    prevAuthors = authorSet;
  }
  return out;
}

// ---- browse ------------------------------------------------------------

export function getBook(id) {
  return hydrateBook(db.prepare('SELECT * FROM books WHERE id = ?').get(id));
}

export function booksByAuthor(authorId, { page = 1, limit } = {}) {
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = db
    .prepare('SELECT COUNT(*) c FROM book_authors WHERE author_id = ?')
    .get(authorId).c;
  const rows = db
    .prepare(
      `SELECT b.* FROM books b
       JOIN book_authors ba ON ba.book_id = b.id
       WHERE ba.author_id = @id AND b.avail <> 0
       ORDER BY b.search_title, b.doc_date DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ id: authorId, limit: l, offset });
  return { items: rows.map(hydrateBook), ...pageMeta(total, p, l) };
}

export function booksBySeries(serId, { page = 1, limit } = {}) {
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = db
    .prepare('SELECT COUNT(*) c FROM book_series WHERE ser_id = ?')
    .get(serId).c;
  const rows = db
    .prepare(
      `SELECT b.*, bs.ser_no FROM books b
       JOIN book_series bs ON bs.book_id = b.id
       WHERE bs.ser_id = @id AND b.avail <> 0
       ORDER BY bs.ser_no, b.search_title
       LIMIT @limit OFFSET @offset`,
    )
    .all({ id: serId, limit: l, offset });
  return { items: rows.map(hydrateBook), ...pageMeta(total, p, l) };
}

export function booksByGenre(genreId, { page = 1, limit } = {}) {
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = db
    .prepare('SELECT COUNT(*) c FROM book_genres WHERE genre_id = ?')
    .get(genreId).c;
  const rows = db
    .prepare(
      `SELECT b.* FROM books b
       JOIN book_genres bg ON bg.book_id = b.id
       WHERE bg.genre_id = @id AND b.avail <> 0
       ORDER BY b.search_title, b.doc_date DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ id: genreId, limit: l, offset });
  return { items: rows.map(hydrateBook), ...pageMeta(total, p, l) };
}

export function booksByCatalog(catId, { page = 1, limit } = {}) {
  const { page: p, limit: l, offset } = paginate(page, limit);
  const where = catId ? 'catalog_id = @id' : 'catalog_id IS NULL';
  const params = catId ? { id: catId, limit: l, offset } : { limit: l, offset };
  const total = db
    .prepare(`SELECT COUNT(*) c FROM books WHERE ${where} AND avail <> 0`)
    .get(catId ? { id: catId } : {}).c;
  const rows = db
    .prepare(
      `SELECT * FROM books WHERE ${where} AND avail <> 0
       ORDER BY search_title LIMIT @limit OFFSET @offset`,
    )
    .all(params);
  return { items: rows.map(hydrateBook), ...pageMeta(total, p, l) };
}

export function childCatalogs(parentId) {
  const where = parentId ? 'parent_id = @id' : 'parent_id IS NULL';
  return db
    .prepare(
      `SELECT c.id, c.cat_name, c.cat_type, c.parent_id,
              (SELECT COUNT(*) FROM books b WHERE b.catalog_id = c.id) AS book_count
       FROM catalogs c WHERE ${where} ORDER BY c.cat_name`,
    )
    .all(parentId ? { id: parentId } : {});
}

// The scanner creates a synthetic "." catalog as the collection root; browse
// should start inside it rather than at the (always empty) NULL parent.
export function rootCatalogId() {
  const row = db.prepare("SELECT id FROM catalogs WHERE path = '.'").get();
  return row ? row.id : null;
}

export function catalogBreadcrumbs(catId) {
  const crumbs = [];
  let cur = catId
    ? db.prepare('SELECT * FROM catalogs WHERE id = ?').get(catId)
    : null;
  while (cur) {
    if (cur.path !== '.') crumbs.unshift({ id: cur.id, name: cur.cat_name });
    cur = cur.parent_id
      ? db.prepare('SELECT * FROM catalogs WHERE id = ?').get(cur.parent_id)
      : null;
  }
  return crumbs;
}

function listBy({ table, searchCol, extraCols, countExpr, extraWhere = '', prefix, langCode, page, limit, hydrate }) {
  const { page: p, limit: l, offset } = paginate(page, limit);
  const like = `${normalize(prefix)}%`;
  const langClause = langCode ? 'AND lang_code = @langCode' : '';
  const params = { like, limit: l, offset };
  if (langCode) params.langCode = langCode;
  const countParams = { like };
  if (langCode) countParams.langCode = langCode;
  const total = db
    .prepare(
      `SELECT COUNT(*) c FROM ${table} WHERE ${searchCol} LIKE @like ${langClause} ${extraWhere}`,
    )
    .get(countParams).c;
  const rows = db
    .prepare(
      `SELECT ${extraCols}${countExpr ? `, ${countExpr} AS book_count` : ''}
       FROM ${table} WHERE ${searchCol} LIKE @like ${langClause} ${extraWhere}
       ORDER BY ${searchCol} LIMIT @limit OFFSET @offset`,
    )
    .all(params);
  return {
    items: hydrate ? rows.map(hydrateBook) : rows,
    ...pageMeta(total, p, l),
  };
}

export function listAuthors({ prefix = '', langCode = 0, page = 1, limit } = {}) {
  return listBy({
    table: 'authors a',
    searchCol: 'a.search_full_name',
    extraCols: 'a.id, a.full_name, a.lang_code',
    countExpr:
      '(SELECT COUNT(*) FROM book_authors ba WHERE ba.author_id = a.id)',
    prefix,
    langCode,
    page,
    limit,
  });
}

export function listSeries({ prefix = '', langCode = 0, page = 1, limit } = {}) {
  return listBy({
    table: 'series s',
    searchCol: 's.search_ser',
    extraCols: 's.id, s.ser, s.lang_code',
    countExpr: '(SELECT COUNT(*) FROM book_series bs WHERE bs.ser_id = s.id)',
    prefix,
    langCode,
    page,
    limit,
  });
}

export function listBooks({ prefix = '', langCode = 0, page = 1, limit } = {}) {
  return listBy({
    table: 'books',
    searchCol: 'search_title',
    extraCols: '*',
    countExpr: null,
    extraWhere: 'AND avail <> 0',
    prefix,
    langCode,
    page,
    limit,
    hydrate: true,
  });
}

export function genreSections() {
  return db
    .prepare(
      `SELECT g.section, MIN(g.id) AS section_id, COUNT(DISTINCT bg.book_id) AS book_count
       FROM genres g LEFT JOIN book_genres bg ON bg.genre_id = g.id
       GROUP BY g.section HAVING book_count > 0 ORDER BY g.section`,
    )
    .all();
}

export function genresInSection(sectionId) {
  const section = db
    .prepare('SELECT section FROM genres WHERE id = ?')
    .get(sectionId);
  if (!section) return [];
  return db
    .prepare(
      `SELECT g.id, g.genre, g.section, g.subsection,
              COUNT(DISTINCT bg.book_id) AS book_count
       FROM genres g LEFT JOIN book_genres bg ON bg.genre_id = g.id
       WHERE g.section = ? GROUP BY g.id HAVING book_count > 0
       ORDER BY g.subsection`,
    )
    .all(section.section);
}

export function stats() {
  const rows = db.prepare('SELECT name, value, update_time FROM counters').all();
  const out = {};
  for (const r of rows) out[r.name] = r.value;
  const last = db
    .prepare("SELECT update_time FROM counters WHERE name = 'allbooks'")
    .get();
  out.lastscan = last ? last.update_time : null;
  return out;
}

export function randomBook() {
  return hydrateBook(
    db.prepare('SELECT * FROM books ORDER BY RANDOM() LIMIT 1').get(),
  );
}
