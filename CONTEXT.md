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
- **Two-phase book search** — `match=exact|all` on `GET /api/search`. The
  *exact* pass requires the whole title, author or series to equal the query,
  caps each branch of the id union and **counts nothing**; the *full* pass is
  the substring search above, with the exact total and duplicate collapsing.
  The web client (`useBookSearch`) issues both at once, paints whichever lands
  first and merges the other in. Exact results are a subset of full results —
  anything that equals the query also contains it — so merging only ever
  appends: nothing already on screen moves or disappears, and a book stays
  downloadable from the partial list while the rest of the catalog is still
  being searched. Only page 1 runs both passes; later pages are offsets into
  the full result, which the exact pass cannot align with.

  The exact pass needs no index beyond the plain btrees the schema changelog
  already creates (`idx_books_search_title` and friends) — `=` is what those serve. An
  earlier version anchored a prefix instead and required a dedicated
  `text_pattern_ops` index just to make the planner use it; exact needs neither
  that index nor the tuning, and returns far fewer rows to begin with. What
  still matters is the *absence of counting*: anchoring alone (with the count
  and dedup left in) cost 475 ms for a query matching 25 000 books out of
  200k — no better than the full pass — because `COUNT(*) OVER ()` and the
  dedup `GROUP BY` walk the whole match set regardless of how the rows were
  found.
- **Random book** (`catalog.randomBook`) — `ORDER BY random()` sorts the whole
  table by a per-row random key, a full scan no index can help with; on a
  large catalog that dominated `GET /api/random`. `pickRandomBookId` instead
  picks a random point in the id space and takes the nearest available id at
  or after it, an index-backed lookup. `__state.randomBookId` caches one
  pre-picked id (via `Settings`'s `getState`, an in-memory read — no query at
  all to check it); a request serves it with a plain primary-key lookup, then
  fires off `refreshRandomBookId` in the background, unawaited, to line up the
  next one. A stale or missing cached id falls back to picking synchronously.
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

## Telegram bot

The bot is a catalog *client*, not a second catalog: it reads the same HTTP API
an OPDS reader would and owns no schema. Its vocabulary is therefore about
presenting and paging Books, not about finding them.

- **Title prefix search** — the bot's only search: Books whose title *starts
  with* the query (`catalog.listBooks`'s `prefix`, i.e. `search_title LIKE
  'Q%'` after `normalize` upper-cases and trims). Deliberately *not* **Unified
  search**, which also matches author and series names and so answers a
  query with Books whose titles contain none of it. The cost is that a word
  from the middle of a title does not match; see
  [ADR 0001](docs/adr/0001-title-only-prefix-search-for-the-bot.md).
- **Result page** — one batch of five Books, each sent as its own
  photo+caption message, followed by one further message carrying the
  summary and selection buttons. The unit the user pages through: "more"
  means the next result page, never a longer one. Deliberately not a
  `sendMediaGroup` album: Telegram only surfaces an album's per-photo
  captions once a user taps into one, showing none of them in the collapsed
  grid the chat feed renders by default, which defeats the point of putting
  anything in the caption at all. Each cover is numbered by its 1-based
  position in the page, and that same number prefixes both its caption and
  its pick button in the summary message, so a user can match a cover to its
  button without recounting — the number resets each page rather than
  accumulating across "more" pages. Each cover's caption carries more than
  its bare title: title, authors, series, language, and an annotation
  snippet, so a user can tell same-titled or same-cover editions apart
  without opening any of them — truncated to Telegram's photo caption limit
  (1024 bytes), longest fields (the annotation) losing their tail first. The
  pick button in the summary message stays a numbered but otherwise bare
  title/author, independent of the fuller caption, since it is also
  Telegram's inline-button label (64 bytes).
- **Book detail** — the full message a pick sends back: everything the web
  UI's Book detail page shows for that Book (title, authors, series, genres,
  format/size/date/language, and the *whole* annotation, not just a snippet)
  next to its Format offer buttons, so the format choice isn't made blind on
  a bare title.
- **Search session** — a **Title prefix search** plus its page cursor, addressed
  by an opaque short token so a paging button can name it within the 64 bytes
  Telegram allows. Cache-shaped and deliberately not durable: a session
  outlives neither a restart nor eviction, and a button naming a session that
  is gone reports the search as expired rather than guessing.
- **Format offer** — the formats a given Book can actually be delivered in:
  every convertible format when its own format is one of them, otherwise its
  native format alone. Distinct from the API's `download_formats`, which omits
  a non-convertible native format entirely and so cannot answer this question.
- **Allowlist** — `TELEGRAM_ALLOWED_USERS` and `TELEGRAM_ALLOWED_CHATS`
  (`config.allowedUsers` / `allowedChats`), two independent sets of Telegram
  numeric ids — user ids and group/supergroup chat ids (negative)
  respectively. Access is granted whenever *either* matches: a listed user's
  identity travels with them into any chat, allowlisted or not, while a
  listed group lets in any of its members, individually listed or not. Both
  `null` (unset, empty, or entirely non-numeric) means unrestricted, which is
  the default — the catalog itself has no notion of a user to gate access
  with, so this pair is the only access control the bot has. A sender outside
  both gets a plain refusal (or a callback alert) before any other handler
  runs, never a silent drop.
- **Catalog timeout** — every `CatalogClient` request carries the same
  `CATALOG_TIMEOUT_MS` (10s) abort budget, so a hung SOPDS API fails one
  request rather than hanging it forever. This matters because grammY's
  default `bot.start()` processes updates one at a time: without a bound, one
  stuck request would queue every other chat's update behind it, not just the
  one that triggered it. `withCatalog` (in `bot.ts`) is the other half — it
  wraps every catalog call a handler makes and replies with one plain message
  on any failure a typed `null` doesn't already cover (a timeout, a network
  error, a non-2xx status), so a failure ends in a reply instead of vanishing
  into `bot.catch`'s bare `console.error`.

Implementation, `bot/src/` (see "Layout" below for how the directory is
grouped): `search/search-flow.ts` runs a Title prefix search and its ADR-0001
fallback; `search/session.ts` is the Search session store; `telegram/result-page.ts`
renders a Result page; `telegram/book-text.ts` renders a `BotBook` as text — a
pick button's bare label, a Result page's caption, and the full Book detail
message — so all three stay in one place instead of drifting apart;
`telegram/format-offer.ts` computes a Format offer; `config.ts` parses the
Allowlist; `catalog/api-client.ts` is the only thing that speaks HTTP to the
server, and gives every request it makes the same Catalog timeout;
`telegram/bot.ts` wires all of it to grammY's commands and `callback_query`
handling (the Allowlist check is the first middleware, ahead of everything
else; `withCatalog` wraps every catalog call a handler makes), with
`telegram/callback.ts` owning the inline-button `callback_data` encoding.

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

`bot/src/` is grouped the same way, by the seam each file sits at rather than
alphabetically:

| directory   | holds                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| `catalog/`  | `api-client.ts` — the only thing that speaks HTTP to the server         |
| `search/`   | `search-flow.ts`, `session.ts` — Title prefix search and its Search session |
| `telegram/` | `bot.ts`, `callback.ts`, `result-page.ts`, `book-text.ts`, `format-offer.ts` — rendering and wiring for Telegram itself |

`config.ts` and `index.ts` stay at the top of `bot/src/`: wiring, not a seam of
their own. See "Telegram bot" above for what each file owns.

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
- **`utils/cron.ts`** — five-field cron expressions (`isValidCron` / `cronMatches`).
  A leaf used by `Settings` validation and by `scanner/schedule.ts`.
