# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SimpleOPDS — an OPDS 1.1 + web catalog server for a local e-book collection
(FB2, EPUB, MOBI, PDF, DjVu, and `.zip` archives of those). Express +
TypeScript (ESM) API in `server/`, React + Vite + MUI UI in `web/`, PostgreSQL
schema managed by Liquibase (`server/db/changelog/`). npm workspaces root at
the repo root.

Read [`CONTEXT.md`](CONTEXT.md) before working in `server/` — it's the domain
glossary (entity shapes, search/scan/hydration algorithms, module seams) and
is denser and more load-bearing than this file. [`README.md`](README.md) has
the feature list, Docker deploy flow, and API endpoint table.

## Commands

All from `server/` unless noted.

```bash
npm run dev                    # tsx watch, http://localhost:8000
npm run build && npm start     # compile to dist/ and run
npm run typecheck              # tsc --noEmit

npm test                       # node:test via tsx, in-process PGlite (SOPDS_TEST_DB=mem)
npx tsx --test test/catalog-unit.test.ts          # single file
npx tsx --test --test-name-pattern="<name>" test/routes.test.ts   # single test
npm run test:coverage          # --experimental-test-coverage

npm run mutate <module-key>    # e.g. `npm run mutate catalog`, `npm run mutate all`
                                # module -> source glob + narrowed test files: see bin/mutate.mjs

npm run scan -- /path/to/books # import a collection
npm run initdb                 # apply the Liquibase schema
npm run reindex                # backfill zip_offset/zip_csize/zip_method for older scans
npm run samples                # generate a sample collection (bin/make-samples.ts)
```

Tests default to `SOPDS_TEST_DB=mem` (PGlite, WASM — no real DB needed). Point
at a real Postgres with `SOPDS_TEST_DB= PGHOST=… PGDATABASE=… npm test`; tests
`TRUNCATE` their tables first. Each DB-backed test file starts its own
in-process Postgres (~4s), which is why `bin/mutate.mjs` narrows test files
per module rather than running the whole suite.

Web (`web/`): `npm run dev` (http://localhost:5173, proxies `/api` etc. to the
API), `npm run build`, `npm run preview`. No lint/test scripts configured
there.

Single-process prod-like run: `cd web && npm run build`, then
`cd ../server && npm start` serves `web/dist` at `/`.

## Architecture

`server/src/` is grouped by role, dependencies point inward:

| directory     | holds                                                          |
| ------------- | --------------------------------------------------------------- |
| `config/`     | env-derived defaults, `SERVER_ROOT` asset resolution             |
| `db/`         | the `Query` surface, pg/PGlite backend, schema bootstrap          |
| `connectors/` | filesystem access: streaming `.zip` reads, book byte reads        |
| `formats/`    | per-format metadata/cover parsers (fb2, epub, mobi)                |
| `services/`   | `catalog`, `settings`, `convert/`, `scanner/` — the domain logic  |
| `routes/`     | Express routers: `api`, `opds`, `admin`, `debug`                   |
| `utils/`      | dependency-free leaves: `http`, `lang`, `cron`, `download`          |

`app.ts` assembles the Express app; `index.ts` is the process entry point
(opens the port, starts the Scanner). `routes` → `services` → `connectors`/`db`;
`utils` depends on nothing.

Key seams (full detail in `CONTEXT.md`):

- **`Query`** (`db/index.ts`) — the only DB surface (`get<T>`/`all<T>`/`run`/`tx`).
  Two backends: `pg` (prod) and PGlite (`SOPDS_TEST_DB=mem`). Placeholders are
  `?`/`@name`, translated to `$n`; bulk statements use native `$n` + arrays.
- **Scanner** (`services/scanner/`) — owns the whole scan lifecycle:
  `Scanner.trigger(reason)`/`status()`/`start()`/`stop()`. Wraps the collection
  walk (`engine.ts`), cron tick (`schedule.ts`), debounced folder-watch
  (`watch.ts`), and a concurrency mutex that queues one follow-up run.
  `GET/POST /api/admin/scan` is its only HTTP surface. The raw one-shot walk
  (`engine.ts` `runOnce()`) is what tests and the CLI call directly.
- **`Settings`** (`services/settings.ts`) — runtime config, read synchronously
  via the `S` accessor off an in-memory cache, written via `setMany`; backs the
  `/settings` page and applies without a restart.
- **`connectors/zip.ts`** — streaming `.zip` access (`zipEntries` async
  iterator, `readZipEntry`, `readZipEntryAt`, `zipLocations`); archives are
  never expanded to disk or fully buffered. `adm-zip` is only used for small
  in-memory cases (parsing one epub, building a one-file download zip).
  `books.zip_offset`/`zip_csize`/`zip_method` cache each book's location
  inside its archive so downloads seek straight to it instead of walking the
  central directory; NULL falls back to lookup-by-name.
- **Convert** (`services/convert/`) — pure-JS `fb2 ⇄ epub ⇄ mobi` converters
  built around a shared IR (`convert/ir.ts`), or Calibre's `ebook-convert`
  when on `PATH`. Results cached under `server/data/convert-cache/`.

## Conventions

- Server code is strict TypeScript ESM, compiled with `tsc` (`module`/`moduleResolution: nodenext`). No ESLint/Prettier config is present — match surrounding style.
- No mocking the DB in tests — the query layer runs against real (in-process) PostgreSQL via PGlite; only `SOPDS_TEST_DB=mem` is the officially supported way to run without a full Postgres.
- Mutation testing (Stryker) targets 100% kill rate per module (`thresholds: { high: 100, low: 100, break: 100 }` in `stryker.config.mjs`) — when adding source to a module covered in `bin/mutate.mjs`'s `MODULES` map, keep its test file(s) able to kill mutants at that level, not just pass coverage.
- Add a new module to `bin/mutate.mjs`'s `MODULES` map when introducing a new source file/directory that should be mutation-tested in isolation.
