# SimpleOPDS Catalog

An OPDS 1.1 and web catalog server for a local e‑book collection — FB2, EPUB,
MOBI, PDF, DjVu, and `.zip` archives of those.

- **API** — Express + TypeScript, ESM (`server/`). Compiled with `tsc` to
  `server/dist/`; dev runs the `.ts` via `tsx`.
- **UI** — React + Vite + MUI (`web/`), served by nginx.
- **DB** — PostgreSQL. Schema is a Liquibase changelog
  ([`server/db/changelog/`](server/db/changelog/)).

## Features

- **Unified search** — one query matches a book by its title, *any* of its
  authors, or *any* of its series
  ([`server/src/services/catalog.ts`](server/src/services/catalog.ts)).
  `/api/search?type=all|books|authors|series`. Each entity is a separate
  request; books run an exact-match pass and a substring pass in parallel and
  the UI merges results as they land.
- **Browse** by catalog tree, author, series, genre, or title prefix.
- **Metadata & covers** extracted from FB2 (encoding-aware), EPUB and MOBI
  ([`server/src/formats/`](server/src/formats/)); a generated placeholder
  otherwise.
- **On-the-fly conversion** — every book is offered as FB2, EPUB and MOBI.
  Native pure-JS converters ([`server/src/services/convert/`](server/src/services/convert/)),
  or Calibre's `ebook-convert` when it is on `PATH`. Results cached under
  `server/data/convert-cache/`.
- **Scanning** ([`server/src/services/scanner/`](server/src/services/scanner/)) —
  on demand, on a cron schedule, or by watching the collection folder.
  Overlapping triggers queue one follow-up run.
- **Large collections** — `.zip` archives are read one entry at a time, never
  expanded to disk. Scans commit in batches (`SOPDS_SCAN_BATCH_SIZE`) so books
  are searchable while a first import is still running, read only each book's
  metadata header, and process several archives in parallel
  (`SOPDS_SCAN_CONCURRENCY`).
- **Settings page** (`/settings`) — collection path, extensions, page size,
  schedule, converter, etc., stored in the DB and applied without a restart.
  Optionally gated by `SOPDS_ADMIN_TOKEN`.
- **E-ink mode** for e-readers — auto-detected, with a manual toggle (`?eink=1`),
  saved per device.

## Deploy with Docker Compose

Needs Docker with the Compose plugin (`docker compose version` ≥ v2). Three
services, all with healthchecks:

| Service | Build | Role |
|---|---|---|
| `postgres` | [`server/Dockerfile.postgres`](server/Dockerfile.postgres) | `postgres:16-alpine` with the schema baked in by Liquibase at build time |
| `api` | [`server/Dockerfile`](server/Dockerfile) | Express API + scanner + OPDS feed |
| `ui` | [`web/Dockerfile`](web/Dockerfile) | nginx serving the React build, proxying `/api`, `/opds`, `/debug`, `/healthz` |

```bash
cp .env.example .env                 # set credentials, ports, catalog title
# point the book-collection and postgres-data mounts in docker-compose.yml
# at real host paths
docker compose up -d --build
docker compose exec api node dist/bin/scan.js   # first import
```

- Web UI: `http://<host>:<SOPDS_UI_PORT>`
- OPDS feed: `http://<host>:<SOPDS_OPDS_PORT>/opds/`

Building `postgres` runs `liquibase update` against a throwaway server and bakes
the dump (schema + `DATABASECHANGELOG`) into the image's init scripts — a fresh
database volume comes up ready, with no runtime migration step. Schema changes
are new changesets in `server/db/changelog/`; the init script only runs on a
fresh volume, so migrate an existing database by running Liquibase against it
before deploying the new image.

```bash
docker compose logs -f api            # follow the API log
docker compose down                   # stop (keeps the db volume)
docker compose down -v                # also delete the db volume
```

Back up the database: `docker compose exec -T postgres pg_dump -U sopds sopds > backup.sql`.

## Local development

Needs Node ≥ 22 and a reachable PostgreSQL.

```bash
# API
cd server
npm install
cp .env.example .env                  # set PG* / DATABASE_URL and SOPDS_ROOT_LIB
npm run initdb                        # apply the schema
npm run scan -- /path/to/books        # import a collection
npm run dev                           # tsx watch on http://localhost:8000

# UI
cd ../web
npm install
npm run dev                           # http://localhost:5173, proxies to the API
```

Single-process: `cd web && npm run build`, then `cd ../server && npm start`
serves `web/dist` at `/`.

The server binds `0.0.0.0` and prints its LAN URLs on startup; set `HOST=127.0.0.1`
to restrict it. No collection handy? `node server/bin/make-samples.js ./books`.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=&type=all\|books\|authors\|series&page=` | unified search |
| `GET /api/books?prefix=&lang=&page=` · `GET /api/books/:id` | browse / detail |
| `GET /api/books/:id/download?format=fb2\|epub\|mobi&zip=1` · `/cover` | file (converted on demand) + cover |
| `GET /api/authors` · `/api/authors/:id/books` | authors |
| `GET /api/series` · `/api/series/:id/books` | series |
| `GET /api/genres?section=` · `/api/genres/:id/books` | genres |
| `GET /api/catalogs?cat=` | catalog tree |
| `GET /api/stats` · `GET /api/random` | stats / random pick |
| `GET/PUT /api/admin/settings` | runtime settings |
| `GET/POST /api/admin/scan` | scan status / trigger |
| `GET /opds/…` | OPDS 1.1 Atom feed |

## Configuration

Bootstrap values come from env vars or `server/.env`
([`server/.env.example`](server/.env.example)): `PORT`, `HOST`, `DATABASE_URL` /
`PG*`, `SOPDS_ROOT_LIB`, `SOPDS_CONVERT_CACHE`, `SOPDS_ADMIN_TOKEN`. Everything
else is edited on `/settings` and stored in the `settings` table.

## Tests

```bash
cd server
npm test                              # node:test via tsx
npm run typecheck                     # tsc --noEmit
```

`npm test` sets `SOPDS_TEST_DB=mem` — the query layer runs against an in-process
PostgreSQL ([PGlite](https://pglite.dev), WASM), so no database is needed. Point
at a real one with `SOPDS_TEST_DB= PGHOST=… PGDATABASE=… npm test` (tests
`TRUNCATE` their tables first).

## License

MIT — see [LICENSE](LICENSE).
