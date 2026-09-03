import db from './db.js';
import { S } from './settings.js';
import { normalize } from './lang.js';
import type {
  Book,
  BookRow,
  AuthorListItem,
  SeriesListItem,
  GenreSection,
  GenreListItem,
  CatalogChild,
  Breadcrumb,
  Page,
  PageMeta,
  PageOpts,
  ListOpts,
  Stats,
} from './types.js';

const clampPage = (p: number | string | undefined): number => {
  const n = Number.parseInt(String(p), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

const clampLimit = (l: number | string | undefined): number => {
  const n = Number.parseInt(String(l), 10);
  if (!Number.isFinite(n) || n <= 0) return S.maxItems;
  return Math.min(n, 200);
};

// ---- hydration helpers -----------------------------------------------------

const AUTHORS_SQL = `SELECT a.id, a.full_name FROM authors a
   JOIN book_authors ba ON ba.author_id = a.id
   WHERE ba.book_id = ? ORDER BY a.full_name`;
const GENRES_SQL = `SELECT g.id, g.genre, g.section, g.subsection FROM genres g
   JOIN book_genres bg ON bg.genre_id = g.id
   WHERE bg.book_id = ? ORDER BY g.subsection`;
const SERIES_SQL = `SELECT s.id, s.ser, bs.ser_no FROM series s
   JOIN book_series bs ON bs.ser_id = s.id
   WHERE bs.book_id = ? ORDER BY bs.ser_no`;

export async function hydrateBook(row: BookRow | undefined): Promise<Book | null> {
  if (!row) return null;
  const [authors, genres, series] = await Promise.all([
    db.all<Book['authors'][number]>(AUTHORS_SQL, [row.id]),
    db.all<Book['genres'][number]>(GENRES_SQL, [row.id]),
    db.all<Book['series'][number]>(SERIES_SQL, [row.id]),
  ]);
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
    authors,
    genres,
    series,
  };
}

const hydrateAll = async (rows: BookRow[]): Promise<Book[]> =>
  (await Promise.all(rows.map(hydrateBook))).filter((b): b is Book => b !== null);

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

function paginate(page: number | string | undefined, limit: number | string | undefined) {
  const p = clampPage(page);
  const l = clampLimit(limit);
  return { page: p, limit: l, offset: (p - 1) * l };
}

function pageMeta(total: number, page: number, limit: number): PageMeta {
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

export async function searchBooks(q: string, { page = 1, limit }: PageOpts = {}): Promise<Page<Book>> {
  const like = `%${normalize(q)}%`;
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = (
    await db.get<{ c: number }>(`SELECT COUNT(DISTINCT b.id) AS c ${BOOK_MATCH_FROM}`, { like })
  )!.c;
  const rows = await db.all<BookRow>(
    `SELECT DISTINCT b.* ${BOOK_MATCH_FROM}
     ORDER BY b.search_title, b.doc_date DESC
     LIMIT @limit OFFSET @offset`,
    { like, limit: l, offset },
  );
  let items = await hydrateAll(rows);
  if (S.doublesHide) items = hideDoubles(items);
  return { items, ...pageMeta(total, p, l) };
}

export async function searchAuthors(
  q: string,
  { page = 1, limit }: PageOpts = {},
): Promise<Page<AuthorListItem>> {
  const like = `%${normalize(q)}%`;
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = (
    await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM authors WHERE search_full_name LIKE ?', [like])
  )!.c;
  const items = await db.all<AuthorListItem>(
    `SELECT a.id, a.full_name, a.lang_code,
            (SELECT COUNT(*) FROM book_authors ba WHERE ba.author_id = a.id) AS book_count
     FROM authors a
     WHERE a.search_full_name LIKE @like
     ORDER BY a.search_full_name
     LIMIT @limit OFFSET @offset`,
    { like, limit: l, offset },
  );
  return { items, ...pageMeta(total, p, l) };
}

export async function searchSeries(
  q: string,
  { page = 1, limit }: PageOpts = {},
): Promise<Page<SeriesListItem>> {
  const like = `%${normalize(q)}%`;
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = (
    await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM series WHERE search_ser LIKE ?', [like])
  )!.c;
  const items = await db.all<SeriesListItem>(
    `SELECT s.id, s.ser, s.lang_code,
            (SELECT COUNT(*) FROM book_series bs WHERE bs.ser_id = s.id) AS book_count
     FROM series s
     WHERE s.search_ser LIKE @like
     ORDER BY s.search_ser
     LIMIT @limit OFFSET @offset`,
    { like, limit: l, offset },
  );
  return { items, ...pageMeta(total, p, l) };
}

export interface SearchAll {
  query: string;
  authors: Page<AuthorListItem>;
  series: Page<SeriesListItem>;
  books: Page<Book>;
}

// Combined overview: a preview of each entity type for a single query.
export async function searchAll(q: string, { previewLimit = 5 } = {}): Promise<SearchAll> {
  const [authors, series, books] = await Promise.all([
    searchAuthors(q, { page: 1, limit: previewLimit }),
    searchSeries(q, { page: 1, limit: previewLimit }),
    searchBooks(q, { page: 1, limit: previewLimit }),
  ]);
  return { query: q, authors, series, books };
}

function hideDoubles(items: Book[]): Book[] {
  const out: Book[] = [];
  let prevTitle: string | null = null;
  let prevAuthors: string | null = null;
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

export async function getBook(id: number): Promise<Book | null> {
  return hydrateBook(await db.get<BookRow>('SELECT * FROM books WHERE id = ?', [id]));
}

export async function booksByAuthor(
  authorId: number,
  { page = 1, limit }: PageOpts = {},
): Promise<Page<Book>> {
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = (
    await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM book_authors WHERE author_id = ?', [authorId])
  )!.c;
  const rows = await db.all<BookRow>(
    `SELECT b.* FROM books b
     JOIN book_authors ba ON ba.book_id = b.id
     WHERE ba.author_id = @id AND b.avail <> 0
     ORDER BY b.search_title, b.doc_date DESC
     LIMIT @limit OFFSET @offset`,
    { id: authorId, limit: l, offset },
  );
  return { items: await hydrateAll(rows), ...pageMeta(total, p, l) };
}

export async function booksBySeries(
  serId: number,
  { page = 1, limit }: PageOpts = {},
): Promise<Page<Book>> {
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = (
    await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM book_series WHERE ser_id = ?', [serId])
  )!.c;
  const rows = await db.all<BookRow>(
    `SELECT b.*, bs.ser_no FROM books b
     JOIN book_series bs ON bs.book_id = b.id
     WHERE bs.ser_id = @id AND b.avail <> 0
     ORDER BY bs.ser_no, b.search_title
     LIMIT @limit OFFSET @offset`,
    { id: serId, limit: l, offset },
  );
  return { items: await hydrateAll(rows), ...pageMeta(total, p, l) };
}

export async function booksByGenre(
  genreId: number,
  { page = 1, limit }: PageOpts = {},
): Promise<Page<Book>> {
  const { page: p, limit: l, offset } = paginate(page, limit);
  const total = (
    await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM book_genres WHERE genre_id = ?', [genreId])
  )!.c;
  const rows = await db.all<BookRow>(
    `SELECT b.* FROM books b
     JOIN book_genres bg ON bg.book_id = b.id
     WHERE bg.genre_id = @id AND b.avail <> 0
     ORDER BY b.search_title, b.doc_date DESC
     LIMIT @limit OFFSET @offset`,
    { id: genreId, limit: l, offset },
  );
  return { items: await hydrateAll(rows), ...pageMeta(total, p, l) };
}

export async function booksByCatalog(
  catId: number | null,
  { page = 1, limit }: PageOpts = {},
): Promise<Page<Book>> {
  const { page: p, limit: l, offset } = paginate(page, limit);
  const where = catId ? 'catalog_id = @id' : 'catalog_id IS NULL';
  const params = catId ? { id: catId, limit: l, offset } : { limit: l, offset };
  const total = (
    await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM books WHERE ${where} AND avail <> 0`,
      catId ? { id: catId } : {},
    )
  )!.c;
  const rows = await db.all<BookRow>(
    `SELECT * FROM books WHERE ${where} AND avail <> 0
     ORDER BY search_title LIMIT @limit OFFSET @offset`,
    params,
  );
  return { items: await hydrateAll(rows), ...pageMeta(total, p, l) };
}

export async function childCatalogs(parentId: number | null): Promise<CatalogChild[]> {
  const where = parentId ? 'parent_id = @id' : 'parent_id IS NULL';
  return db.all<CatalogChild>(
    `SELECT c.id, c.cat_name, c.cat_type, c.parent_id,
            (SELECT COUNT(*) FROM books b WHERE b.catalog_id = c.id) AS book_count
     FROM catalogs c WHERE ${where} ORDER BY c.cat_name`,
    parentId ? { id: parentId } : {},
  );
}

// The scanner creates a synthetic "." catalog as the collection root; browse
// should start inside it rather than at the (always empty) NULL parent.
export async function rootCatalogId(): Promise<number | null> {
  const row = await db.get<{ id: number }>("SELECT id FROM catalogs WHERE path = '.'");
  return row ? row.id : null;
}

interface CatalogRow {
  id: number;
  parent_id: number | null;
  cat_name: string;
  path: string;
}

export async function catalogBreadcrumbs(catId: number | null): Promise<Breadcrumb[]> {
  const crumbs: Breadcrumb[] = [];
  let cur = catId
    ? await db.get<CatalogRow>('SELECT * FROM catalogs WHERE id = ?', [catId])
    : undefined;
  while (cur) {
    if (cur.path !== '.') crumbs.unshift({ id: cur.id, name: cur.cat_name });
    cur = cur.parent_id
      ? await db.get<CatalogRow>('SELECT * FROM catalogs WHERE id = ?', [cur.parent_id])
      : undefined;
  }
  return crumbs;
}

interface ListByOpts {
  table: string;
  searchCol: string;
  extraCols: string;
  countExpr: string | null;
  extraWhere?: string;
  prefix: string;
  langCode: number;
  page: number | string | undefined;
  limit: number | string | undefined;
  hydrate?: boolean;
}

async function listBy<T>({
  table,
  searchCol,
  extraCols,
  countExpr,
  extraWhere = '',
  prefix,
  langCode,
  page,
  limit,
  hydrate,
}: ListByOpts): Promise<Page<T>> {
  const { page: p, limit: l, offset } = paginate(page, limit);
  const like = `${normalize(prefix)}%`;
  const langClause = langCode ? 'AND lang_code = @langCode' : '';
  const params: Record<string, string | number> = { like, limit: l, offset };
  if (langCode) params.langCode = langCode;
  const countParams: Record<string, string | number> = { like };
  if (langCode) countParams.langCode = langCode;
  const total = (
    await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${table} WHERE ${searchCol} LIKE @like ${langClause} ${extraWhere}`,
      countParams,
    )
  )!.c;
  const rows = await db.all<unknown>(
    `SELECT ${extraCols}${countExpr ? `, ${countExpr} AS book_count` : ''}
     FROM ${table} WHERE ${searchCol} LIKE @like ${langClause} ${extraWhere}
     ORDER BY ${searchCol} LIMIT @limit OFFSET @offset`,
    params,
  );
  const items = hydrate ? await hydrateAll(rows as BookRow[]) : (rows as T[]);
  return { items: items as T[], ...pageMeta(total, p, l) };
}

export function listAuthors({
  prefix = '',
  langCode = 0,
  page = 1,
  limit,
}: ListOpts = {}): Promise<Page<AuthorListItem>> {
  return listBy<AuthorListItem>({
    table: 'authors a',
    searchCol: 'a.search_full_name',
    extraCols: 'a.id, a.full_name, a.lang_code',
    countExpr: '(SELECT COUNT(*) FROM book_authors ba WHERE ba.author_id = a.id)',
    prefix,
    langCode,
    page,
    limit,
  });
}

export function listSeries({
  prefix = '',
  langCode = 0,
  page = 1,
  limit,
}: ListOpts = {}): Promise<Page<SeriesListItem>> {
  return listBy<SeriesListItem>({
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

export function listBooks({
  prefix = '',
  langCode = 0,
  page = 1,
  limit,
}: ListOpts = {}): Promise<Page<Book>> {
  return listBy<Book>({
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

export function genreSections(): Promise<GenreSection[]> {
  return db.all<GenreSection>(
    `SELECT g.section, MIN(g.id) AS section_id, COUNT(DISTINCT bg.book_id) AS book_count
     FROM genres g LEFT JOIN book_genres bg ON bg.genre_id = g.id
     GROUP BY g.section HAVING COUNT(DISTINCT bg.book_id) > 0 ORDER BY g.section`,
  );
}

export async function genresInSection(sectionId: number): Promise<GenreListItem[]> {
  const section = await db.get<{ section: string }>('SELECT section FROM genres WHERE id = ?', [
    sectionId,
  ]);
  if (!section) return [];
  return db.all<GenreListItem>(
    `SELECT g.id, g.genre, g.section, g.subsection,
            COUNT(DISTINCT bg.book_id) AS book_count
     FROM genres g LEFT JOIN book_genres bg ON bg.genre_id = g.id
     WHERE g.section = ? GROUP BY g.id HAVING COUNT(DISTINCT bg.book_id) > 0
     ORDER BY g.subsection`,
    [section.section],
  );
}

export async function stats(): Promise<Stats> {
  const rows = await db.all<{ name: string; value: number; update_time: Date | string }>(
    'SELECT name, value, update_time FROM counters',
  );
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.name] = r.value;
  const last = await db.get<{ update_time: Date | string }>(
    "SELECT update_time FROM counters WHERE name = 'allbooks'",
  );
  return {
    allbooks: counts.allbooks,
    allcatalogs: counts.allcatalogs,
    allauthors: counts.allauthors,
    allgenres: counts.allgenres,
    allseries: counts.allseries,
    lastscan: last ? last.update_time : null,
  };
}

export async function randomBook(): Promise<Book | null> {
  return hydrateBook(await db.get<BookRow>('SELECT * FROM books ORDER BY random() LIMIT 1'));
}
