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

export interface Db extends Query {
  end(): Promise<void>;
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
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

const db: Db = {
  ...makeApi((text, values) => backend.query(text, values)),
  end: () => backend.end(),
  async tx<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    const client = await backend.connect();
    const api = makeApi((text, values) => client.query(text, values));
    try {
      await client.query('BEGIN', []);
      const result = await fn(api);
      await client.query('COMMIT', []);
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK', []);
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    } finally {
      client.release();
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
