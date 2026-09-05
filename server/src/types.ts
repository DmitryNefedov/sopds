/**
 * Catalog domain types — the shapes that cross the `repo`, route and OPDS
 * seams. Declared once here so the API, the OPDS feed and the scanner cannot
 * drift from each other or from the database schema.
 */

// ---- database rows ----------------------------------------------------

/** A row of the `books` table, as returned by `SELECT * FROM books`. */
export interface BookRow {
  id: number;
  filename: string;
  path: string;
  filesize: number;
  format: string;
  catalog_id: number | null;
  cat_type: number;
  register_date: Date | string;
  doc_date: string;
  lang: string;
  title: string;
  search_title: string;
  annotation: string;
  lang_code: number;
  avail: number;
  /** Location of the entry inside its `.zip` (see schema.sql); null for loose
   *  files and for rows catalogued before the scan recorded them. */
  zip_offset: number | null;
  zip_csize: number | null;
  zip_method: number | null;
  /** present when the query joins `book_series` */
  ser_no?: number;
}

// ---- hydrated entities ----------------------------------------------

export interface BookAuthor {
  id: number;
  full_name: string;
}

export interface BookGenre {
  id: number;
  genre: string;
  section: string;
  subsection: string;
}

export interface BookSeries {
  id: number;
  ser: string;
  ser_no: number;
}

/** A fully hydrated book: the unit the API and OPDS feed serve. */
export interface Book {
  id: number;
  title: string;
  filename: string;
  path: string;
  format: string;
  filesize: number;
  cat_type: number;
  lang: string;
  lang_code: number;
  doc_date: string;
  register_date: Date | string;
  annotation: string;
  catalog_id: number | null;
  /** Where the entry lives inside its `.zip` (see `BookRow`); null for loose
   *  files and for rows catalogued before the scan recorded it. */
  zip_offset: number | null;
  zip_csize: number | null;
  zip_method: number | null;
  authors: BookAuthor[];
  genres: BookGenre[];
  series: BookSeries[];
  /** set by the duplicate-collapsing pass in listings */
  doubles?: number;
  /** attached by GET /api/books/:id */
  download_formats?: DownloadFormat[];
}

export interface DownloadFormat {
  format: string;
  native: boolean;
  convertible: boolean;
  url: string;
}

export interface AuthorListItem {
  id: number;
  full_name: string;
  lang_code: number;
  book_count: number;
}

export interface SeriesListItem {
  id: number;
  ser: string;
  lang_code: number;
  book_count: number;
}

export interface GenreSection {
  section: string;
  section_id: number;
  book_count: number;
}

export interface GenreListItem {
  id: number;
  genre: string;
  section: string;
  subsection: string;
  book_count: number;
}

export interface CatalogChild {
  id: number;
  cat_name: string;
  cat_type: number;
  parent_id: number | null;
  book_count: number;
}

export interface Breadcrumb {
  id: number;
  name: string;
}

// ---- pagination -----------------------------------------------------

export interface PageMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
  has_next: boolean;
  has_prev: boolean;
  /** Set by a pass that counted nothing, so `total` is what it returned rather
   *  than what exists. The quick half of a search sets it. */
  partial?: boolean;
}

export type Page<T> = { items: T[] } & PageMeta;

export interface PageOpts {
  page?: number | string;
  limit?: number | string;
}

export interface ListOpts extends PageOpts {
  prefix?: string;
  langCode?: number;
}

// ---- stats --------------------------------------------------------

export interface Stats {
  allbooks?: number;
  allcatalogs?: number;
  allauthors?: number;
  allgenres?: number;
  allseries?: number;
  lastscan: Date | string | null;
}

// ---- scanner output -----------------------------------------------

export interface SeriesRef {
  title: string;
  index?: number;
}

/** Normalised metadata extracted from a book file by `formats/parseBook`. */
export interface BookMeta {
  title: string;
  authors: string[];
  genres: string[];
  series: SeriesRef | null;
  lang: string;
  docdate: string;
  annotation: string;
  langCode: number;
  format: string;
}

/** An embedded cover image pulled from a book file. */
export interface CoverImage {
  data: Buffer;
  mime: string;
}

export interface ScanStats {
  added: number;
  skipped: number;
  removed: number;
  bad: number;
  archives: number;
  error?: string;
}

/** One completed Scan run, persisted as `__state.lastScan` and shown in the admin UI. */
export interface ScanRecord extends Partial<ScanStats> {
  startedAt: string;
  finishedAt: string;
  reason: string;
  error?: string;
}

/** Live status of the Scanner module. */
export interface ScanStatus {
  running: boolean;
  progress: { added: number; skipped: number } | null;
  last: ScanRecord | null;
  enabled: boolean;
  cron: string;
  watch: { watching: boolean; watchedDirs: number; pending: boolean };
}
