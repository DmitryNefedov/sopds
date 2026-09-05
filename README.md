# SimpleOPDS Catalog

An OPDS / web catalog server for a local e‑book collection (FB2, EPUB, MOBI, PDF,
DjVu, and `.zip` archives of those).

This repository was **rewritten from Django to a Node.js + React stack**:

| Layer    | Was                        | Now                                         |
|----------|----------------------------|---------------------------------------------|
| API      | Django + django-constance  | **Express** (`server/`), **TypeScript**, ESM |
| UI       | Django templates + Foundation | **React + Vite + MUI** (`web/`)          |
| DB       | Django ORM / sqlite3       | **PostgreSQL** (`server/schema.sql`, `node-postgres`) |
| Scanner  | `sopds_scanner` mgmt command | `npm --workspace server run scan` + in-app scheduler |
| OPDS feed| `opds_catalog.feeds`       | `server/src/routes/opds.ts` (Atom / OPDS 1.1)|
| Converters| external `fb2epub` / `fb2mobi` binaries | built-in TS `server/src/services/convert/`, or Calibre |
| Admin    | Django admin + django-constance | `/settings` page + `server/src/services/settings.ts` |

The server is TypeScript compiled with `tsc` to `server/dist/` (dev runs the
`.ts` directly via `tsx`). Catalog domain types live in
[`server/src/types.ts`](server/src/types.ts); the typed query layer is
[`server/src/db/`](server/src/db/).

The original Django code is kept for reference under [`old/`](old/)
(`old/opds_catalog/`, `old/sopds/`, `old/sopds_web_backend/`, …); its docs are
in [`old/docs-legacy-django.md`](old/docs-legacy-django.md).

## Highlights

- **Unified search.** One query searches **authors, book titles _and_ series
  names together**. A book is returned when the query matches its title, *any*
  of its authors, or *any* of its series — see `searchBooks()` /
  `BOOK_MATCH_IDS` in
  [`server/src/services/catalog.ts`](server/src/services/catalog.ts). The
  `/api/search` endpoint also returns a combined overview (`type=all`) or a
  paginated list per entity (`type=books|authors|series`).
- Browse by catalog tree, author, series, genre, or title prefix.
- **Metadata & cover extraction** for FB2 (with `windows-1251` / declared-encoding
  support), EPUB and MOBI — title, authors, series, language, and the embedded
  cover image (`server/src/formats/`). Books without an embedded cover fall back to
  a generated placeholder (`server/assets/nocover.svg` / `.png`, rebuild with
  `python3 server/bin/make-nocover.py`).
- Book detail and downloads (raw or zipped).
- **On-the-fly format conversion.** Every book is offered as **FB2, EPUB and
  MOBI** even if only one format is on disk. The server converts between the
  three natively (`server/src/services/convert/`, pure JS — FB2⇄EPUB⇄MOBI, PalmDOC MOBI
  read/write); if Calibre's `ebook-convert` is on `PATH` it is used instead for
  higher fidelity. Converted files are cached under `server/data/convert-cache/`.
  Endpoint: `GET /api/books/:id/download?format=epub`.
- **Settings page** (`/settings`) — the equivalent of the old Django admin /
  django-constance screen. Edit the book-collection path, file extensions, page
  size, duplicate hiding, the external converter, etc. at runtime (persisted in
  the DB, no restart). Optionally protect it with `SOPDS_ADMIN_TOKEN`.
- **Three ways to scan** the collection, all owned by the Scanner module
  (`server/src/services/scanner/`): on demand from the settings page ("Scan now"), on a
  **cron schedule** (`scanner/schedule.ts`, minute resolution), and by **watching
  the folder** (`scanner/watch.ts`) — a debounced rescan a few seconds after files
  are added, changed or removed. Overlapping triggers queue one follow-up run.
- **Built for large collections.** `.zip` archives are read one entry at a
  time (`server/src/connectors/zip.ts`, streaming) — never expanded to disk, never loaded
  whole into memory. The scan commits books in batches (`SOPDS_SCAN_BATCH_SIZE`,
  default 10 000) so a first import of hundreds of thousands of books makes them
  searchable and downloadable as it runs, instead of only at the end.
  A scan reads only each book's metadata header — for FB2, the bytes up to
  `</description>` — so the body text and the embedded cover are never
  decompressed or parsed; covers are read from the file on demand instead.
  Books are written to PostgreSQL in bulk statements, and several archives are
  read in parallel (`SOPDS_SCAN_CONCURRENCY`, default: from the available CPUs).
  On a collection of FB2 files in `.zip` archives that is worth roughly **20x**
  over reading each book whole.
- OPDS 1.1 Atom feed at `/opds/` for e‑reader apps.
- Light / dark MUI theme, plus an **e-ink mode** for e-readers (Lenovo Smart
  Paper, Onyx Boox, …). Auto-detected client-side from `(update: slow)` /
  `(monochrome)` media queries, User-Agent markers and a strict
  reduced-motion heuristic. Browsers that give no reliable signal (e.g. Firefox
  on the same reader) instead get a one-tap **"switch to e-ink mode?"** prompt
  when the soft signals line up (reduced motion + touch-only + reader-shaped
  screen). Manual toggle in the top bar and on `/settings` (also `?eink=1`); the
  choice is saved per device. `prefers-reduced-motion` also disables animations
  in the normal colour theme. The e-ink theme is a refined grayscale design —
  layered gray tones, light borders and rounded corners (no colour, no
  animation, no shadows), larger hit targets, and every cover — real or the
  placeholder — greyscaled with a CSS filter.

## Deploy with Docker Compose

Needs **Docker** with the Compose plugin (`docker compose version` ≥ v2). The
stack is defined in [`docker-compose.yml`](docker-compose.yml) — three services:

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:16-alpine` | catalog database, data in a volume |
| `api` | built from [`server/Dockerfile`](server/Dockerfile) | Express API + scanner + OPDS feed |
| `ui` | built from [`web/Dockerfile`](web/Dockerfile) | nginx serving the React build, reverse-proxying `/api`, `/opds`, `/debug`, `/healthz` to `api` |

All three services have a compose **healthcheck**. `api` serves `GET /health`
(and `/healthz`), which also pings the database, so `ui` waits for `api` to be
healthy before starting; nginx answers its own `GET /health` locally.

### 1. Configure

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Meaning | Default |
|---|---|---|
| `SOPDS_BOOKS_DIR` | host folder holding the e-books, bind-mounted **read-only** at `/books` | `./books` |
| `SOPDS_PGDATA` | PostgreSQL storage — a Docker **named volume** name, or an absolute **host path** to bind-mount | named volume `sopds-pgdata` |
| `SOPDS_UI_PORT` | host port for the web UI | `8080` |
| `SOPDS_OPDS_PORT` | host port for the raw API / OPDS feed (for reader apps) | `8000` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | database credentials — **change the password for a real deployment** | `sopds` |
| `SOPDS_ADMIN_TOKEN` | if set, the `/settings` admin API requires this token | _(unset)_ |
| `SOPDS_TITLE` / `SOPDS_SUBTITLE` | catalog name shown in the UI and OPDS feed | _SimpleOPDS…_ |

### 2. Build

```bash
docker compose build          # builds the api and ui images
```

### 3. Deploy

```bash
docker compose up -d          # start postgres + api + ui in the background
docker compose exec api node dist/bin/scan.js   # first import of the collection
```

- Web UI: `http://<host>:8080`
- OPDS feed for e-reader apps: `http://<host>:8000/opds/` (also reachable at `http://<host>:8080/opds/`)

`docker compose up -d --build` does the build and the start in one step. The `api`
container waits for `postgres` to become healthy and creates the schema itself on
first boot — no migration step.

Keeping the catalog current after the first import: turn on **scheduled scans**
and/or **folder-watch** on the `/settings` page (both run inside the `api`
container), or re-run `docker compose exec api node dist/bin/scan.js` whenever you add
books.

### Operating

```bash
docker compose ps                 # service status
docker compose logs -f api        # follow the API log
docker compose restart api        # restart one service
docker compose down               # stop and remove containers (keeps the db volume)
docker compose down -v            # also delete the database volume
```

### Updating

```bash
git pull
docker compose up -d --build      # rebuild changed images, recreate containers
```

The database volume is preserved across rebuilds, so the catalog survives. If the
schema changed, the `api` container applies additive changes (`CREATE TABLE /
INDEX IF NOT EXISTS`) on boot.

### Deploying on a server

- Put the stack behind a reverse proxy (nginx / Caddy / Traefik) terminating TLS
  and forwarding to `SOPDS_UI_PORT`. Drop `SOPDS_OPDS_PORT`'s published port if
  you don't need reader apps hitting the API directly, or proxy `/opds/` too.
- Set a strong `POSTGRES_PASSWORD` (and `SOPDS_ADMIN_TOKEN`) in `.env` before the
  first `up` — the password is only read when the db volume is first created.
- Point `SOPDS_BOOKS_DIR` at the real library path on the host; it is mounted
  read-only, the container never writes to it.
- Back up the database volume, e.g.:

  ```bash
  docker compose exec -T postgres pg_dump -U sopds sopds > sopds-backup.sql
  # restore: docker compose exec -T postgres psql -U sopds sopds < sopds-backup.sql
  ```

## Quick start (local, no Docker)

Requires **Node 20+** and a reachable **PostgreSQL** instance.

```bash
# 1. API server
cd server
npm install
cp .env.example .env               # set PG* / DATABASE_URL and SOPDS_ROOT_LIB
npm run initdb                     # create the schema
npm run scan -- /path/to/books     # import the collection (runs the .ts via tsx)
npm run build && npm start         # tsc -> dist/, then http://localhost:8000
#   or, for development:  npm run dev   (tsx watch, no build step)

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

The server binds `0.0.0.0` by default, so it is reachable from other devices on
your network (e-readers, tablets) — it prints the LAN URLs on startup. Set
`HOST=127.0.0.1` to restrict it to localhost. `npm run dev` for the UI also
listens on all interfaces (point it at a non-local API with `SOPDS_API=`).

No book collection handy? `node server/bin/make-samples.js ./books` writes a tiny
sample library.

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
| `GET /debug` · `GET /debug/headers` | device / request inspection |

## Configuration

Bootstrap values come from env vars (or `server/.env`), see
[`server/.env.example`](server/.env.example): `PORT`, `DATABASE_URL` / `PG*`,
`SOPDS_ROOT_LIB`, `SOPDS_CONVERT_CACHE`, `SOPDS_ADMIN_TOKEN`, and the initial
defaults for the tunables below.

Everything else is edited at runtime on the **`/settings`** page and stored in
the database (`settings` table): catalog title/subtitle, book collection path,
file extensions, zip scanning, scan batch size, "remove missing books",
scheduled-scan on/off + cron expression, folder-watch on/off + settle time,
items per page, duplicate hiding, cover display, external converter command, and
download-filename style.

## Tests

```bash
cd server && npm test    # node:test via tsx — search, conversions, settings/cron, folder watch
npm --workspace server run typecheck   # tsc --noEmit
```

No database needed: `npm test` sets `SOPDS_TEST_DB=mem`, which runs the query
layer against an in-process PostgreSQL ([PGlite](https://pglite.dev), WASM)
instead of connecting to a server. Point the tests at a real PostgreSQL with
`SOPDS_TEST_DB= PGHOST=… PGDATABASE=… npm test` (they `TRUNCATE` their tables
first).

## License

See [License](License).
