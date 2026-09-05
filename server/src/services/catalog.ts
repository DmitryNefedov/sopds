import db from '../db/index.js';
import type { SqlParam } from '../db/index.js';
import type { BookRef } from '../connectors/bookfiles.js';
import { S } from './settings.js';
import { normalize } from '../utils/lang.js';
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
} from '../types.js';

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
  return assemble(row, authors, genres, series);
}

// ---- batched hydration -----------------------------------------------------
// A page of books used to cost three queries per book — 60 round trips for a
// listing of 20, which over a network dominated the listing itself. These fetch
// all three relations for the whole page at once and group them in memory.

const AUTHORS_BATCH = `SELECT ba.book_id, a.id, a.full_name FROM authors a
   JOIN book_authors ba ON ba.author_id = a.id
   WHERE ba.book_id = ANY($1::int[]) ORDER BY a.full_name`;
const GENRES_BATCH = `SELECT bg.book_id, g.id, g.genre, g.section, g.subsection FROM genres g
   JOIN book_genres bg ON bg.genre_id = g.id
   WHERE bg.book_id = ANY($1::int[]) ORDER BY g.subsection`;
const SERIES_BATCH = `SELECT bs.book_id, s.id, s.ser, bs.ser_no FROM series s
   JOIN book_series bs ON bs.ser_id = s.id
   WHERE bs.book_id = ANY($1::int[]) ORDER BY bs.ser_no`;

/** Group rows carrying a `book_id` by that id, dropping the key from each row. */
function groupByBook<T extends { book_id: number }>(rows: T[]): Map<number, Omit<T, 'book_id'>[]> {
  const out = new Map<number, Omit<T, 'book_id'>[]>();
  for (const row of rows) {
    const { book_id: id, ...rest } = row;
    const list = out.get(id);
    if (list) list.push(rest);
    else out.set(id, [rest]);
  }
  return out;
}

function assemble(
  row: BookRow,
  authors: Book['authors'],
  genres: Book['genres'],
  series: Book['series'],
): Book {
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
    zip_offset: row.zip_offset ?? null,
    zip_csize: row.zip_csize ?? null,
    zip_method: row.zip_method ?? null,
    authors,
    genres,
    series,
  };
}

/** Hydrate a whole page of books with three queries, not three per book. */
export const hydrateAll = async (rows: BookRow[]): Promise<Book[]> => {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id) as unknown as SqlParam;
  const [authors, genres, series] = await Promise.all([
    db.all<Book['authors'][number] & { book_id: number }>(AUTHORS_BATCH, [ids]),
    db.all<Book['genres'][number] & { book_id: number }>(GENRES_BATCH, [ids]),
    db.all<Book['series'][number] & { book_id: number }>(SERIES_BATCH, [ids]),
  ]);
  const byAuthor = groupByBook(authors);
  const byGenre = groupByBook(genres);
  const bySeries = groupByBook(series);
  const empty: never[] = [];
  return rows.map((row) =>
    assemble(
      row,
      (byAuthor.get(row.id) ?? empty) as Book['authors'],
      (byGenre.get(row.id) ?? empty) as Book['genres'],
      (bySeries.get(row.id) ?? empty) as Book['series'],
    ),
  );
};

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

// A book matches when the query hits its title, any of its authors or any of
// its series. Collecting ids per side and joining `books` once afterwards beats
// the obvious three-way LEFT JOIN + DISTINCT (1.36 s -> 147 ms on 120k books),
// because it scales with the number of matches rather than the catalog.
const BOOK_MATCH_IDS = `
  WITH ids AS (
      SELECT b.id FROM books b WHERE b.avail <> 0 AND b.search_title LIKE @like
    UNION
      SELECT ba.book_id FROM authors a
        JOIN book_authors ba ON ba.author_id = a.id
       WHERE a.search_full_name LIKE @like
    UNION
      SELECT bs.book_id FROM series s
        JOIN book_series bs ON bs.ser_id = s.id
       WHERE s.search_ser LIKE @like
  )
`;

// With "hide doubles" on, editions sharing a title and author set (`dkey`/`akey`)
// collapse to the newest one. This has to happen before the LIMIT, or a page
// returns fewer rows than asked for and `total` counts editions nobody sees.
const BOOK_DEDUP_CTES = `
  , matched AS (
      SELECT b.id, b.search_title, b.doc_date, UPPER(b.title) AS dkey,
             COALESCE(string_agg(CAST(ba.author_id AS text), ',' ORDER BY ba.author_id), '') AS akey
        FROM books b
        JOIN ids ON ids.id = b.id
        LEFT JOIN book_authors ba ON ba.book_id = b.id
       WHERE b.avail <> 0
       GROUP BY b.id, b.search_title, b.doc_date, b.title
    ),
    grp AS (
      SELECT DISTINCT ON (dkey, akey)
             id, COUNT(*) OVER (PARTITION BY dkey, akey) - 1 AS doubles
        FROM matched
       ORDER BY dkey, akey, doc_date DESC NULLS LAST, id
    )`;

export async function searchBooks(q: string, { page = 1, limit }: PageOpts = {}): Promise<Page<Book>> {
  const like = `%${normalize(q)}%`;
  const { page: p, limit: l, offset } = paginate(page, limit);
  const dedup = S.doublesHide;

  // `COUNT(*) OVER ()` rides along with the page, so the match set is built
  // once per search instead of once for the count and again for the rows.
  const rows = await db.all<BookRow & { total: number; doubles: number }>(
    dedup
      ? `${BOOK_MATCH_IDS}${BOOK_DEDUP_CTES}
         SELECT b.*, grp.doubles, COUNT(*) OVER () AS total
           FROM grp JOIN books b ON b.id = grp.id
          ORDER BY b.search_title, b.doc_date DESC
          LIMIT @limit OFFSET @offset`
      : `${BOOK_MATCH_IDS}
         SELECT b.*, 0 AS doubles, COUNT(*) OVER () AS total
           FROM books b JOIN ids ON ids.id = b.id
          WHERE b.avail <> 0
          ORDER BY b.search_title, b.doc_date DESC
          LIMIT @limit OFFSET @offset`,
    { like, limit: l, offset },
  );
  // An offset past the end returns nothing, so fall back to a plain count only
  // in that case rather than on every search.
  const total = rows.length
    ? Number(rows[0].total)
    : offset === 0
      ? 0
      : (await db.get<{ c: number }>(
          dedup
            ? `${BOOK_MATCH_IDS}${BOOK_DEDUP_CTES} SELECT COUNT(*) AS c FROM grp`
            : `${BOOK_MATCH_IDS} SELECT COUNT(*) AS c FROM ids`,
          { like },
        ))!.c;

  const hydrated = await hydrateAll(rows);
  // hydrateAll maps over `rows` in order, so index i lines up with rows[i].
  const items = dedup
    ? hydrated.map((b, i) => ({ ...b, doubles: Number(rows[i].doubles) }))
    : hydrated;
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

// ---- browse ------------------------------------------------------------

/** Just enough of a book to read its bytes — no author/genre/series joins. */
export function getBookRef(id: number): Promise<BookRef | undefined> {
  return db.get<BookRef>(
    'SELECT path, filename, cat_type, zip_offset, zip_csize, zip_method FROM books WHERE id = ?',
    [id],
  );
}

export async function getBook(id: number): Promise<Book | null> {
  return hydrateBook(await db.get<BookRow>('SELECT * FROM books WHERE id = ?', [id]));
}

export async function booksByAuthor(
  authorId: number,
  { page = 1, limit }: PageOpts = {},
): Promise<Page<Book>> {
  const { page: p, limit: l, offset } = paginate(page, limit);
  // Counted through `books` so the total matches the rows the query below can
  // return: a join row whose book is unavailable would promise a page that
  // paging then cannot deliver.
  const total = (
    await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM book_authors ba
         JOIN books b ON b.id = ba.book_id
        WHERE ba.author_id = ? AND b.avail <> 0`,
      [authorId],
    )
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
    await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM book_series bs
         JOIN books b ON b.id = bs.book_id
        WHERE bs.ser_id = ? AND b.avail <> 0`,
      [serId],
    )
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
    await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM book_genres bg
         JOIN books b ON b.id = bg.book_id
        WHERE bg.genre_id = ? AND b.avail <> 0`,
      [genreId],
    )
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
