# SimpleOPDS Catalog

An OPDS / web catalog server for a local e‑book collection (FB2, EPUB, MOBI, PDF,
DjVu, and `.zip` archives of those).

This repository was **rewritten from Django to a Node.js + React stack**:

| Layer    | Was                        | Now                                         |
|----------|----------------------------|---------------------------------------------|
| API      | Django + django-constance  | **Express** (`server/`), ESM, `node:sqlite` |
| UI       | Django templates + Foundation | **React + Vite + MUI** (`web/`)          |
| DB       | Django ORM / sqlite3       | plain SQLite (`server/src/schema.sql`)       |
| Scanner  | `sopds_scanner` mgmt command | `node server/bin/scan.js`                  |
| OPDS feed| `opds_catalog.feeds`       | `server/src/routes/opds.js` (Atom / OPDS 1.1)|

The original Django code is kept for reference (`opds_catalog/`, `sopds/`,
`sopds_web_backend/`, …) and its docs are in
[`docs-legacy-django.md`](docs-legacy-django.md).

## Highlights

- **Unified search.** One query searches **authors, book titles _and_ series
  names together**. A book is returned when the query matches its title, *any*
  of its authors, or *any* of its series — see `searchBooks()` /
  `BOOK_MATCH_FROM` in [`server/src/repo.js`](server/src/repo.js). The
  `/api/search` endpoint also returns a combined overview (`type=all`) or a
  paginated list per entity (`type=books|authors|series`).
- Browse by catalog tree, author, series, genre, or title prefix.
- Book detail with cover extraction (embedded FB2 / EPUB covers), annotation,
  download (raw or zipped).
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
| `GET /api/books/:id/download?zip=1` · `GET /api/books/:id/cover` | file + cover |
| `GET /api/authors` · `GET /api/authors/:id/books` | authors |
| `GET /api/series` · `GET /api/series/:id/books` | series |
| `GET /api/genres?section=` · `GET /api/genres/:id/books` | genres |
| `GET /api/catalogs?cat=` | catalog tree |
| `GET /api/stats` · `GET /api/random` | catalog stats / random pick |
| `POST /api/scan` | trigger a rescan |
| `GET /opds/…` | OPDS 1.1 Atom feed |

## Configuration

All via env vars (or `server/.env`), see [`server/.env.example`](server/.env.example):
`PORT`, `SOPDS_DB`, `SOPDS_ROOT_LIB`, `SOPDS_BOOK_EXTENSIONS`, `SOPDS_ZIPSCAN`,
`SOPDS_MAXITEMS`, `SOPDS_DOUBLES_HIDE`, `SOPDS_TITLE`, `SOPDS_SUBTITLE`.

## Tests

```bash
cd server && npm test    # node:test — covers the unified search
```

## License

See [License](License).
