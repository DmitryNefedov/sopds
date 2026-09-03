# Domain glossary — SimpleOPDS

Shared vocabulary for the catalog. The server's TypeScript types in
[`server/src/types.ts`](server/src/types.ts) are the canonical shape of each
term; this file is the prose.

## Entities

- **Book** — one book file on disk (or one entry inside a `.zip`). Hydrated for
  the API/OPDS as `Book`: the `books` row plus its `authors`, `genres` and
  `series`. A **BookRow** is the raw `books` table row before hydration.
- **Author**, **Series**, **Genre** — many-to-many with Book via the
  `book_authors` / `book_series` / `book_genres` join tables. In listings they
  come back as `AuthorListItem` / `SeriesListItem` / `GenreListItem` — the
  entity plus a `book_count`.
- **Catalog** — a node in the directory tree of the collection. The scanner
  makes a synthetic `.` catalog as the browse root. `CatalogChild` is one
  child directory with its `book_count`; a **Breadcrumb** is one ancestor.
- **BookMeta** — normalised metadata extracted from a book file by
  `books/parseBook` (title, authors, genres, series, language). The scanner's
  input; distinct from the hydrated `Book` that is the API's output.
- **IR** (`convert/ir.ts`) — the intermediate representation every format
  converter reads into and writes out of (`fb2 ⇄ epub ⇄ mobi`).

## Operations

- **Unified search** — one query matches a Book by its own title, *any* of its
  authors, or *any* of its series (`BOOK_MATCH_FROM` in `repo.ts`).
  `type=all|books|authors|series` on `GET /api/search`.
- **Scan** — walk the collection, upsert Books/Authors/Series/Genres, mark
  vanished files unavailable. Produces `ScanStats`. Commits in batches of
  `scanBatchSize` (default 10 000) via `db.begin()`, so books are published to
  the catalog while the scan is still running rather than in one final commit.
  `.zip` archives are streamed entry by entry (`zip.ts`) — never expanded to
  disk, never read whole into memory. An archive whose `cat_size` is unchanged
  since the last scan is skipped without being reopened. The raw one-shot is
  `scan/engine.ts` `runOnce()` (the CLI and the tests call it directly); the
  server always goes through the **Scanner**.
- **Hydrate** — turn a `BookRow` into a `Book` by loading its related authors,
  genres and series (`repo.hydrateBook`).
- **Page&lt;T&gt;** — a slice of a listing: `items` plus `total` / `page` /
  `limit` / `pages` / `has_next` / `has_prev`.

## Seams

- **`Query`** (`db.ts`) — the query surface (`get<T>` / `all<T>` / `run` /
  `tx`). Two adapters behind it: `pg` in production, PGlite (in-process
  PostgreSQL) under `SOPDS_TEST_DB=mem`. Placeholders are written `?` / `@name`
  and translated to `$n`. `db.tx(fn)` wraps a unit of work; `db.begin()` returns
  a **`Tx`** you commit/roll back yourself (the scanner's batch flushing).
- **Scanner** (`scan/`) — the one module that owns **Scan**: `Scanner.trigger(reason)`
  / `status()` / `start()` / `stop()`. Behind it: the collection walk
  (`scan/engine.ts`), the cron tick (`scan/schedule.ts`), the debounced
  folder-watch (`scan/watch.ts`), a single concurrency mutex that queues one
  follow-up run (last reason wins), and the run / progress / last-run state
  (`__state.lastScan`). `GET/POST /api/admin/scan` is its only HTTP surface.
- **`zip.ts`** — streaming read access to `.zip` archives (`zipEntries` async
  iterator, `readZipEntry`). Used by the scanner and by book downloads so a
  huge archive is never expanded or fully buffered. `adm-zip` is still used for
  the small in-memory cases (parsing one epub, building a one-file download zip).
- **`Settings`** (`settings.ts`) — runtime-editable config, read synchronously
  through the `S` accessor off an in-memory cache; written via `setMany`.
- **`cron.ts`** — five-field cron expressions (`isValidCron` / `cronMatches`).
  A leaf used by `Settings` validation and by `scan/schedule.ts`.
