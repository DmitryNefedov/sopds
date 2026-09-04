import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { SERVER_ROOT } from './paths.js';

// ---- public types -----------------------------------------------------

export type SqlParam = string | number | boolean | null | undefined | Buffer | Date;
/** `?`-positional (array) or `@name`-named (object) parameters. */
export type Params = SqlParam[] | Record<string, SqlParam>;

export interface RunResult {
  rowCount: number;
  rows: unknown[];
}

/** The query surface, bound either to the pool or to one transaction client. */
export interface Query {
  query(sql: string, params?: Params): Promise<{ rows: unknown[]; rowCount: number }>;
  all<T = unknown>(sql: string, params?: Params): Promise<T[]>;
  get<T = unknown>(sql: string, params?: Params): Promise<T | undefined>;
  run(sql: string, params?: Params): Promise<RunResult>;
  /** Raw single-statement SQL, no parameter translation. */
  exec(sql: string): Promise<unknown>;
}

/** A transaction you drive by hand: run statements, then `commit()` or `rollback()`. */
export interface Tx extends Query {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface Db extends Query {
  end(): Promise<void>;
  /** Run `fn` inside a transaction, committing on success and rolling back on throw. */
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  /** Open a transaction to commit/roll back yourself — used by the scanner to
   *  flush books to the catalog in batches instead of one huge commit. */
  begin(): Promise<Tx>;
}

// ---- backend selection --------------------------------------------------
//
// Production talks to a real PostgreSQL server via `pg`. Tests set
// SOPDS_TEST_DB=mem to run against an in-process PostgreSQL (PGlite / WASM) so
// `npm test` needs no database. Both speak the same SQL — PGlite *is*
// PostgreSQL — so nothing else in the codebase changes.

type RawResult = { rows: unknown[]; rowCount?: number | null; affectedRows?: number };
type RawRunner = (text: string, values: unknown[]) => Promise<RawResult>;

interface Backend {
  query: RawRunner;
  connect(): Promise<{ query: RawRunner; release(): void }>;
  on(event: 'error', cb: (err: Error) => void): void;
  end(): Promise<void>;
  execScript(sql: string): Promise<unknown>;
}

const useMemory = process.env.SOPDS_TEST_DB === 'mem';
const backend: Backend = useMemory ? await memoryBackend() : await realBackend();

async function memoryBackend(): Promise<Backend> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite();
  const run: RawRunner = async (text, values) => {
    const r = await lite.query(text, values ?? []);
    return { rows: r.rows as unknown[], affectedRows: r.affectedRows };
  };
  return {
    query: run,
    connect: async () => ({ query: run, release() {} }),
    on: () => {},
    end: () => lite.close(),
    execScript: (sql) => lite.exec(sql),
  };
}

async function realBackend(): Promise<Backend> {
  const pg = (await import('pg')).default;

  // node-postgres returns BIGINT / NUMERIC as strings by default. The catalog
  // only ever stores small integers in those columns, so parse them as numbers
  // to keep the rest of the code (and the JSON API) working with plain numbers.
  pg.types.setTypeParser(20, (v: string | null) => (v === null ? null : Number(v))); // int8
  pg.types.setTypeParser(1700, (v: string | null) => (v === null ? null : Number(v))); // numeric

  const pool = new pg.Pool(
    config.db.url
      ? { connectionString: config.db.url }
      : {
          host: config.db.host,
          port: config.db.port,
          user: config.db.user,
          password: config.db.password,
          database: config.db.database,
        },
  );
  pool.on('error', (err) => {
    console.error('unexpected postgres pool error', err);
  });
  return {
    query: (text, values) => pool.query(text, values),
    connect: () => pool.connect(),
    on: (event, cb) => pool.on(event, cb),
    end: () => pool.end(),
    execScript: (sql) => pool.query(sql),
  };
}

// ---- placeholder translation -------------------------------------------
//
// The query layer was written against node:sqlite, which uses `?` positional
// and `@name` named parameters. Postgres wants `$1, $2, …`. `translate()`
// rewrites a statement + its params into the pg form so the call sites stay
// close to their original shape.
function translate(sql: string, params: Params | undefined): { text: string; values: unknown[] } {
  if (params == null) return { text: sql, values: [] };

  if (Array.isArray(params)) {
    let i = 0;
    const text = sql.replace(/\?/g, () => `$${++i}`);
    return { text, values: params.map(coerce) };
  }

  // object params: @name / :name
  const values: unknown[] = [];
  const index = new Map<string, number>();
  const text = sql.replace(/[@:]([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name: string) => {
    if (!index.has(name)) {
      values.push(coerce(params[name]));
      index.set(name, values.length);
    }
    return `$${index.get(name)}`;
  });
  return { text, values };
}

// node:sqlite accepted numbers/strings/null/Buffer; callers occasionally pass
// booleans or undefined. Postgres handles booleans, but the schema stores 0/1
// integers, so keep the old coercion.
function coerce(v: SqlParam): SqlParam {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// ---- query helpers ----------------------------------------------------
function makeApi(runner: RawRunner): Query {
  return {
    async query(sql, params) {
      const { text, values } = translate(sql, params);
      const r = await runner(text, values);
      return { rows: r.rows, rowCount: r.rowCount ?? r.affectedRows ?? r.rows.length };
    },
    async all<T = unknown>(sql: string, params?: Params) {
      const { text, values } = translate(sql, params);
      const r = await runner(text, values);
      return r.rows as T[];
    },
    async get<T = unknown>(sql: string, params?: Params) {
      const { text, values } = translate(sql, params);
      const r = await runner(text, values);
      return r.rows[0] as T | undefined;
    },
    async run(sql, params) {
      const { text, values } = translate(sql, params);
      const r = await runner(text, values);
      return { rowCount: r.rowCount ?? r.affectedRows ?? r.rows.length, rows: r.rows };
    },
    exec(sql) {
      return runner(sql, []);
    },
  };
}

async function begin(): Promise<Tx> {
  const client = await backend.connect();
  const api = makeApi((text, values) => client.query(text, values));
  await client.query('BEGIN', []);
  let settled = false;
  const finish = async (verb: 'COMMIT' | 'ROLLBACK'): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await client.query(verb, []);
    } catch {
      /* ignore: a failed COMMIT/ROLLBACK still needs the client released */
    } finally {
      client.release();
    }
  };
  return { ...api, commit: () => finish('COMMIT'), rollback: () => finish('ROLLBACK') };
}

const db: Db = {
  ...makeApi((text, values) => backend.query(text, values)),
  end: () => backend.end(),
  begin,
  async tx<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    const t = await begin();
    try {
      const result = await fn(t);
      await t.commit();
      return result;
    } catch (err) {
      await t.rollback();
      throw err;
    }
  },
};

// ---- schema / bootstrap --------------------------------------------------

let schemaReady: Promise<void> | null = null;

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

// Search is `LIKE '%text%'`, which a btree index cannot help with at all — the
// leading wildcard forces a sequential scan of every author, series and title.
// A GIN trigram index does serve it, and on a 1M-book catalog that is the
// difference between seconds and milliseconds.
//
// pg_trgm ships with PostgreSQL but not with PGlite (the in-process build the
// tests run against), and creating an extension needs rights a locked-down role
// may not have. So this is best-effort: without the indexes every query returns
// exactly the same rows, just more slowly.
//
// Two things make this a background job rather than part of startup. Building a
// GIN index over a million titles takes minutes, and `initSchema()` runs before
// the HTTP port opens — waiting for it would fail the container's healthcheck.
// CONCURRENTLY then keeps the table readable and writable while it builds, at
// the cost of not being allowed inside a transaction (hence `backend.query`,
// which runs on the pool).
const TRIGRAM_INDEXES: [string, string, string][] = [
  ['idx_books_title_trgm', 'books', 'search_title'],
  ['idx_authors_name_trgm', 'authors', 'search_full_name'],
  ['idx_series_ser_trgm', 'series', 'search_ser'],
];

/** Create the text-search indexes if this database can have them. Safe to call
 *  on every boot: each statement is a no-op once the index exists. */
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

export default db;
