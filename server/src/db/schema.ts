import fs from 'node:fs';
import path from 'node:path';
import db from './index.js';
import { backend } from './backend.js';
import { SERVER_ROOT } from '../config/paths.js';

// Everything that brings an empty database up to a usable catalog: waiting for
// the server, applying schema.sql, seeding genres, indexes and counters.

let schemaReady: Promise<void> | null = null;

/** Apply `schema.sql` and seed the genre fixture. Idempotent, and runs at most
 *  once per process however many callers await it. */
export function initSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await waitForPostgres();
    const schema = fs.readFileSync(path.join(SERVER_ROOT, 'schema.sql'), 'utf8');
    await backend.execScript(schema);
    await seedGenres();
  })();
  return schemaReady;
}

async function waitForPostgres(attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await backend.query('SELECT 1', []);
      return;
    } catch (err) {
      if (i === attempts) throw err;
      if (i === 1) console.log('waiting for postgres…');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

interface GenreFixtureRow {
  fields?: { genre?: string; section?: string; subsection?: string };
}

/** Load `genres.json` into an empty `genres` table, so books scanned later map
 *  onto named sections instead of "Unknown genre". */
async function seedGenres(): Promise<void> {
  const have = (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM genres'))!.c;
  if (have > 0) return;
  const fixturePath = path.join(SERVER_ROOT, 'genres.json');
  if (!fs.existsSync(fixturePath)) return;
  const rows = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as GenreFixtureRow[];
  await db.tx(async (cx) => {
    for (const it of rows) {
      const f = it.fields || {};
      await cx.run(
        `INSERT INTO genres (genre, section, subsection) VALUES (?, ?, ?)
         ON CONFLICT (genre) DO NOTHING`,
        [f.genre ?? null, f.section || '', f.subsection || ''],
      );
    }
  });
}

// Search is `LIKE '%text%'`, whose leading wildcard no btree index can serve; a
// GIN trigram index does, and on a 1M-book catalog that is seconds versus
// milliseconds. It is best-effort: pg_trgm ships with PostgreSQL but not with
// PGlite, and creating an extension needs rights a locked-down role may lack.
const TRIGRAM_INDEXES: [string, string, string][] = [
  ['idx_books_title_trgm', 'books', 'search_title'],
  ['idx_authors_name_trgm', 'authors', 'search_full_name'],
  ['idx_series_ser_trgm', 'series', 'search_ser'],
];

/**
 * Create the text-search indexes if this database can have them. Called after
 * the HTTP port opens — a GIN index over a million titles takes minutes, and
 * CONCURRENTLY (which keeps the table writable meanwhile) cannot run inside a
 * transaction, hence `backend.query` rather than `db.tx`.
 */
export async function ensureSearchIndexes(log = console.log): Promise<boolean> {
  const why = (err: unknown) => String((err as Error).message).split('\n')[0];
  try {
    await backend.query('CREATE EXTENSION IF NOT EXISTS pg_trgm', []);
  } catch (err) {
    log(
      `search: pg_trgm unavailable (${why(err)}); ` +
        'text search falls back to sequential scans',
    );
    return false;
  }
  for (const [name, table, column] of TRIGRAM_INDEXES) {
    const started = Date.now();
    try {
      await backend.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
           ON ${table} USING gin (${column} gin_trgm_ops)`,
        [],
      );
      const secs = (Date.now() - started) / 1000;
      if (secs > 1) log(`search: built ${name} in ${secs.toFixed(0)}s`);
    } catch (err) {
      // A cancelled CONCURRENTLY build leaves an invalid index behind, which
      // `IF NOT EXISTS` would then skip forever — say so rather than fail quietly.
      log(`search: could not build ${name}: ${why(err)} (DROP INDEX ${name} to retry)`);
      return false;
    }
  }
  await backend.query('ANALYZE books, authors, series', []).catch(() => {});
  return true;
}

/** Recompute the catalog-wide totals the stats endpoint and OPDS root serve. */
export async function updateCounters(): Promise<void> {
  const set = (name: string, value: number) =>
    db.run(
      `INSERT INTO counters (name, value, update_time) VALUES (?, ?, now())
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, update_time = EXCLUDED.update_time`,
      [name, value],
    );
  const count = async (t: string) =>
    (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`))!.c;
  await set('allbooks', await count('books'));
  await set('allcatalogs', await count('catalogs'));
  await set('allauthors', await count('authors'));
  await set('allgenres', await count('genres'));
  await set('allseries', await count('series'));
}
