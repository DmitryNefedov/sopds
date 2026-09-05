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
  `formats/parseBook` (title, authors, genres, series, language). The scanner's
  input; distinct from the hydrated `Book` that is the API's output.
- **IR** (`services/convert/ir.ts`) — the intermediate representation every format
  converter reads into and writes out of (`fb2 ⇄ epub ⇄ mobi`).

## Operations

- **Unified search** — one query matches a Book by its own title, *any* of its
  authors, or *any* of its series (`BOOK_MATCH_IDS` in `services/catalog.ts`, which collects
  matching book ids from each side and unions them rather than joining all three
  and de-duplicating afterwards). `type=all|books|authors|series` on
  `GET /api/search`; the overview page issues one request per type in parallel
  and paints each section as its own results arrive, books first.
  Text matching is `LIKE '%…%'`, which no btree index can serve, so `db/schema.ts`
  `ensureSearchIndexes()` creates GIN trigram indexes in the background after
  the port opens — best-effort, since PGlite has no `pg_trgm`.
- **Two-phase book search** — `match=prefix|all` on `GET /api/search`. The
  *quick* pass anchors the pattern (`FOO%`), caps each branch of the id union
  and **counts nothing**; the *full* pass is the substring search above, with
  the exact total and duplicate collapsing. Measured on 200k books: 9 ms
  against 380 ms. The web client (`useBookSearch`) issues both at once, paints
  whichever lands first and merges the other in. Quick results are a subset of
  full results, so merging only ever appends — nothing already on screen moves
  or disappears, and a book stays downloadable from the partial list while the
  rest of the catalog is still being searched. Only page 1 runs both passes;
  later pages are offsets into the full result, which the quick pass cannot
  align with.

  What makes the quick pass quick is the *absence of counting*, not the index:
  anchoring alone still cost 475 ms for a query matching 25 000 books, because
  `COUNT(*) OVER ()` and the dedup `GROUP BY` walk the whole match set. Each
  branch must also carry `ORDER BY … USING ~<~` — the `text_pattern_ops`
  operator class's own ordering — or the planner either picks the
  collation-ordered btree (93 ms) or, with no sort at all, a seq scan that
  returns an arbitrary sample.
- **Batched hydration** — `catalog.hydrateAll` loads a whole page's authors,
  genres and series with three `= ANY(...)` queries instead of three per book.
- **Scan** — walk the collection, upsert Books/Authors/Series/Genres, mark
  vanished files unavailable. Produces `ScanStats`. Commits in batches of
  `scanBatchSize` (default 10 000) via `db.begin()`, so books are published to
  the catalog while the scan is still running rather than in one final commit.
  `.zip` archives are streamed entry by entry (`connectors/zip.ts`) — never expanded to
  disk, never read whole into memory. An archive whose `cat_size` is unchanged
  since the last scan is skipped without being reopened. The raw one-shot is
  `services/scanner/engine.ts` `runOnce()` (the CLI and the tests call it directly); the
  server always goes through the **Scanner**.
- **Read plan** (`formats/metaReadPlan`) — how much of a file a scan reads, per
  format, so the walk never inflates bytes no parser will look at. `fb2` stops
  at `</description>`; `mobi` takes the front of the file (PalmDB record 0);
  `epub` has to be read whole (it is a zip, central directory last); anything
  else (`pdf`, `djvu`) is catalogued from its filename and never read at all.
  Combined with `metaOnly` — which also skips decoding the cover — this is what
  makes a 700k-book walk cheap. Covers are re-read on demand by
  `connectors/bookfiles.ts` `readBookCover`, so nothing is lost.
- **Bulk write** — the scan's unit of database work. Up to 500 parsed books go
  out as one `INSERT … SELECT * FROM UNNEST(…) ON CONFLICT` per table, and a
  directory's or archive's already-known filenames arrive in a single query, so
  the walk costs a handful of round-trips per thousand books instead of five
  per book. `scanConcurrency` readers work in parallel (decompression runs on
  libuv's threadpool) while every write funnels through one serialised
  `Writer`, which owns the batch transaction.
- **Hydrate** — turn a `BookRow` into a `Book` by loading its related authors,
  genres and series (`catalog.hydrateBook`).
- **Page&lt;T&gt;** — a slice of a listing: `items` plus `total` / `page` /
  `limit` / `pages` / `has_next` / `has_prev`.

## Layout

`server/src/` is grouped by role, not by file type:

| directory     | holds                                                        |
| ------------- | ------------------------------------------------------------ |
| `config/`     | env-derived defaults and `SERVER_ROOT` asset resolution        |
| `db/`         | the `Query` surface, the pg/PGlite backend, schema bootstrap   |
| `connectors/` | the filesystem: streaming `.zip` access, reading book bytes    |
| `formats/`    | per-format metadata and cover parsers (fb2, epub, mobi)        |
| `services/`   | `catalog`, `settings`, `convert/`, `scanner/` — the domain     |
| `routes/`     | Express routers: `api`, `opds`, `admin`, `debug`               |
| `utils/`      | leaves with no domain knowledge: `http`, `lang`, `cron`, `download` |

`app.ts` assembles the Express app; `index.ts` is the process entry point that
opens the port and starts the Scanner. Dependencies point inward — `routes` use
`services`, `services` use `connectors` / `db`, and `utils` depends on nothing.

## Seams

- **`Query`** (`db/index.ts`) — the query surface (`get<T>` / `all<T>` / `run` /
  `tx`). Two adapters behind it: `pg` in production, PGlite (in-process
  PostgreSQL) under `SOPDS_TEST_DB=mem`. Placeholders are written `?` / `@name`
  and translated to `$n`. `db.tx(fn)` wraps a unit of work; `db.begin()` returns
  a **`Tx`** you commit/roll back yourself (the scanner's batch flushing).
  Bulk statements are written in native `$n` form and pass arrays straight
  through.
- **Scanner** (`services/scanner/`) — the one module that owns **Scan**: `Scanner.trigger(reason)`
  / `status()` / `start()` / `stop()`. Behind it: the collection walk
  (`scanner/engine.ts`), the cron tick (`scanner/schedule.ts`), the debounced
  folder-watch (`scanner/watch.ts`), a single concurrency mutex that queues one
  follow-up run (last reason wins), and the run / progress / last-run state
  (`__state.lastScan`). `GET/POST /api/admin/scan` is its only HTTP surface.
- **Zip location** (`books.zip_offset` / `zip_csize` / `zip_method`) — where a
  book's bytes start inside its archive, recorded by the scan. Finding an entry
  by name means walking the archive's central directory, which is O(entries)
  and costs ~75 ms on a 2500-book archive — far more than inflating the book.
  With a location, `connectors/bookfiles.ts` `readBookBytes` seeks straight to
  it (~2 ms).
  NULL means "look it up by name", which is also the fallback when the recorded
  offset no longer holds a local file header, so a rewritten archive degrades
  instead of breaking. `bin/reindex-zips.ts` backfills a catalog scanned before
  these existed, reading central directories only.
- **`connectors/zip.ts`** — streaming read access to `.zip` archives (`zipEntries` async
  iterator, `readZipEntry`, `readZipEntryAt`, `zipLocations`). Used by the scanner and by book downloads so a
  huge archive is never expanded or fully buffered. `adm-zip` is still used for
  the small in-memory cases (parsing one epub, building a one-file download zip).
- **`Settings`** (`services/settings.ts`) — runtime-editable config, read synchronously
  through the `S` accessor off an in-memory cache; written via `setMany`.
- **Anchored indexes** (`idx_*_prefix`) — btree `text_pattern_ops` indexes on
  the three `search_*` columns, built alongside the trigram ones. They need no
  extension, so the quick pass stays fast even where `pg_trgm` is unavailable.
- **`utils/cron.ts`** — five-field cron expressions (`isValidCron` / `cronMatches`).
  A leaf used by `Settings` validation and by `scanner/schedule.ts`.
