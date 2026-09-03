# SimpleOPDS Catalog

An OPDS / web catalog server for a local e‑book collection (FB2, EPUB, MOBI, PDF,
DjVu, and `.zip` archives of those).

This repository was **rewritten from Django to a Node.js + React stack**:

| Layer    | Was                        | Now                                         |
|----------|----------------------------|---------------------------------------------|
| API      | Django + django-constance  | **Express** (`server/`), ESM, `node:sqlite` |
| UI       | Django templates + Foundation | **React + Vite + MUI** (`web/`)          |
| DB       | Django ORM / sqlite3       | plain SQLite (`server/src/schema.sql`)       |
| Scanner  | `sopds_scanner` mgmt command | `node server/bin/scan.js` + in-app scheduler |
| OPDS feed| `opds_catalog.feeds`       | `server/src/routes/opds.js` (Atom / OPDS 1.1)|
| Converters| external `fb2epub`/`fb2mobi`/kindlegen | built-in JS `server/src/convert/`, or Calibre |
| Admin    | Django admin + django-constance | `/settings` page + `server/src/settings.js` |

The original Django code is kept for reference under [`old/`](old/)
(`old/opds_catalog/`, `old/sopds/`, `old/sopds_web_backend/`, …); its docs are
in [`old/docs-legacy-django.md`](old/docs-legacy-django.md).

## Highlights

- **Unified search.** One query searches **authors, book titles _and_ series
  names together**. A book is returned when the query matches its title, *any*
  of its authors, or *any* of its series — see `searchBooks()` /
  `BOOK_MATCH_FROM` in [`server/src/repo.js`](server/src/repo.js). The
  `/api/search` endpoint also returns a combined overview (`type=all`) or a
  paginated list per entity (`type=books|authors|series`).
- Browse by catalog tree, author, series, genre, or title prefix.
- **Metadata & cover extraction** for FB2 (with `windows-1251` / declared-encoding
  support), EPUB and MOBI — title, authors, series, language, and the embedded
  cover image (`server/src/books/`). Books without an embedded cover fall back to
  a generated placeholder (`server/assets/nocover.svg` / `.png`, rebuild with
  `python3 server/bin/make-nocover.py`).
- Book detail and downloads (raw or zipped).
- **On-the-fly format conversion.** Every book is offered as **FB2, EPUB and
  MOBI** even if only one format is on disk. The server converts between the
  three natively (`server/src/convert/`, pure JS — FB2⇄EPUB⇄MOBI, PalmDOC MOBI
  read/write); if Calibre's `ebook-convert` is on `PATH` it is used instead for
  higher fidelity. Converted files are cached under `server/data/convert-cache/`.
  Endpoint: `GET /api/books/:id/download?format=epub`.
- **Settings page** (`/settings`) — the equivalent of the old Django admin /
  django-constance screen. Edit the book-collection path, file extensions, page
  size, duplicate hiding, the external converter, etc. at runtime (persisted in
  the DB, no restart). Optionally protect it with `SOPDS_ADMIN_TOKEN`.
- **Three ways to scan** the collection: on demand from the settings page
  ("Scan now"), on a **cron schedule** (`server/src/scheduler.js`, minute
  resolution), and by **watching the folder** (`server/src/watcher.js`) — a
  debounced rescan a few seconds after files are added, changed or removed.
- OPDS 1.1 Atom feed at `/opds/` for e‑reader apps.
- Light / dark MUI theme.

## Quick start

Requires **Node 22+** (uses the built-in `node:sqlite` module — no native build).

```bash
# 1. API server
cd server
npm install
cp .env.example .env            # then edit SOPDS_ROOT_LIB
node bin/scan.js /path/to/books  # import the collection
npm start                        # http://localhost:8000

# 2. UI (dev, with hot reload + API proxy)
cd ../web
npm install
npm run dev                      # http://localhost:5173
```

For a single-process deployment, build the UI and let the API serve it:

```bash
cd web && npm run build          # -> web/dist
cd ../server && npm start        # serves web/dist at /
```

No book collection handy? `node server/bin/make-samples.js` writes a tiny sample
library into `server/books/`.

## API overview

| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=&type=all\|books\|authors\|series&page=` | unified cross-entity search |
| `GET /api/books?prefix=&lang=&page=` · `GET /api/books/:id` | browse / detail |
| `GET /api/books/:id/download?format=fb2\|epub\|mobi&zip=1` · `GET /api/books/:id/cover` | file (converted on demand) + cover |
| `GET /api/convert-info` | which conversion engine is active |
| `GET /api/authors` · `GET /api/authors/:id/books` | authors |
| `GET /api/series` · `GET /api/series/:id/books` | series |
| `GET /api/genres?section=` · `GET /api/genres/:id/books` | genres |
| `GET /api/catalogs?cat=` | catalog tree |
| `GET /api/stats` · `GET /api/random` | catalog stats / random pick |
| `GET/PUT /api/admin/settings` | read / update runtime settings |
| `GET /api/admin/scan` · `POST /api/admin/scan` | scan status / trigger a rescan |
| `GET /api/admin/check-path?path=` | validate a directory path |
| `GET /opds/…` | OPDS 1.1 Atom feed |

## Configuration

Bootstrap values come from env vars (or `server/.env`), see
[`server/.env.example`](server/.env.example): `PORT`, `SOPDS_DB`,
`SOPDS_ROOT_LIB`, `SOPDS_CONVERT_CACHE`, `SOPDS_ADMIN_TOKEN`, and the initial
defaults for the tunables below.

Everything else is edited at runtime on the **`/settings`** page and stored in
the database (`settings` table): catalog title/subtitle, book collection path,
file extensions, zip scanning, "remove missing books", scheduled-scan on/off +
cron expression, folder-watch on/off + settle time, items per page, duplicate
hiding, cover display, external converter command, and download-filename style.

## Tests

```bash
cd server && npm test    # node:test — search, conversions, settings/cron, folder watch
```

## License

See [License](License).
