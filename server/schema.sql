-- SimpleOPDS schema (Node rewrite, PostgreSQL). Mirrors the original Django
-- data model (opds_catalog_*) with friendlier table names.

CREATE TABLE IF NOT EXISTS catalogs (
  id        SERIAL PRIMARY KEY,
  parent_id INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
  cat_name  TEXT NOT NULL,
  path      TEXT NOT NULL,
  cat_type  INTEGER NOT NULL DEFAULT 0, -- 0 normal dir, 1 zip, 2 inpx, 3 inp
  cat_size  BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_catalogs_parent ON catalogs(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalogs_path ON catalogs(path);

CREATE TABLE IF NOT EXISTS books (
  id            SERIAL PRIMARY KEY,
  filename      TEXT NOT NULL,
  path          TEXT NOT NULL,
  filesize      BIGINT NOT NULL DEFAULT 0,
  format        TEXT NOT NULL,
  catalog_id    INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
  cat_type      INTEGER NOT NULL DEFAULT 0,
  register_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  doc_date      TEXT DEFAULT '',
  lang          TEXT DEFAULT '',
  title         TEXT NOT NULL,
  search_title  TEXT NOT NULL DEFAULT '',
  annotation    TEXT DEFAULT '',
  lang_code     INTEGER NOT NULL DEFAULT 9,
  avail         INTEGER NOT NULL DEFAULT 0
);
-- Where this book's bytes live inside its .zip, recorded by the scan. Lets a
-- download or cover seek straight to the entry instead of walking the archive's
-- central directory, which is O(entries) and dominates the cost of serving a
-- cover. NULL for loose files, and for rows catalogued before these columns
-- existed — `files.ts` falls back to the directory walk for those.
ALTER TABLE books ADD COLUMN IF NOT EXISTS zip_offset BIGINT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS zip_csize  BIGINT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS zip_method INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_books_file ON books(path, filename);
CREATE INDEX IF NOT EXISTS idx_books_search_title ON books(search_title);
CREATE INDEX IF NOT EXISTS idx_books_catalog ON books(catalog_id);
CREATE INDEX IF NOT EXISTS idx_books_lang_code ON books(lang_code);

CREATE TABLE IF NOT EXISTS authors (
  id               SERIAL PRIMARY KEY,
  full_name        TEXT NOT NULL,
  search_full_name TEXT NOT NULL DEFAULT '',
  lang_code        INTEGER NOT NULL DEFAULT 9
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_authors_name ON authors(full_name);
CREATE INDEX IF NOT EXISTS idx_authors_search ON authors(search_full_name);

CREATE TABLE IF NOT EXISTS series (
  id         SERIAL PRIMARY KEY,
  ser        TEXT NOT NULL,
  search_ser TEXT NOT NULL DEFAULT '',
  lang_code  INTEGER NOT NULL DEFAULT 9
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_series_ser ON series(ser);
CREATE INDEX IF NOT EXISTS idx_series_search ON series(search_ser);

CREATE TABLE IF NOT EXISTS genres (
  id         SERIAL PRIMARY KEY,
  genre      TEXT NOT NULL,
  section    TEXT NOT NULL DEFAULT '',
  subsection TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_genres_genre ON genres(genre);

CREATE TABLE IF NOT EXISTS book_authors (
  book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, author_id)
);
CREATE INDEX IF NOT EXISTS idx_ba_author ON book_authors(author_id);

CREATE TABLE IF NOT EXISTS book_genres (
  book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, genre_id)
);
CREATE INDEX IF NOT EXISTS idx_bg_genre ON book_genres(genre_id);

CREATE TABLE IF NOT EXISTS book_series (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  ser_id  INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  ser_no  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, ser_id)
);
CREATE INDEX IF NOT EXISTS idx_bs_ser ON book_series(ser_id);

CREATE TABLE IF NOT EXISTS counters (
  name        TEXT PRIMARY KEY,
  value       INTEGER NOT NULL DEFAULT 0,
  update_time TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
