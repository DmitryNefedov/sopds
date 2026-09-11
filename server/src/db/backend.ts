import config from '../config/index.js';

// The raw driver behind the query surface. Production talks to a real
// PostgreSQL server via `pg`; tests set SOPDS_TEST_DB=mem to run against an
// in-process PostgreSQL (PGlite / WASM), so `npm test` needs no database.

export type RawResult = { rows: unknown[]; rowCount?: number | null; affectedRows?: number };
export type RawRunner = (text: string, values: unknown[]) => Promise<RawResult>;

export interface Backend {
  query: RawRunner;
  connect(): Promise<{ query: RawRunner; release(): void }>;
  end(): Promise<void>;
  /** Run a multi-statement script (the schema changelog) with no parameters. */
  execScript(sql: string): Promise<unknown>;
}

export async function memoryBackend(): Promise<Backend> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite();
  const run: RawRunner = async (text, values) => {
    // Stryker disable next-line ArrayDeclaration: the query surface always passes
    // an array; `?? []` is only for a direct caller that omits params.
    const r = await lite.query(text, values ?? []);
    return { rows: r.rows as unknown[], affectedRows: r.affectedRows };
  };
  return {
    query: run,
    connect: async () => ({ query: run, release() {} }),
    // Stryker disable next-line ArrowFunction: a teardown call with no observable
    // effect within a single test process.
    end: () => lite.close(),
    execScript: (sql) => lite.exec(sql),
  };
}

/** Turn the resolved DB config into a node-postgres Pool config: a connection
 *  string when `DATABASE_URL` was set, otherwise the discrete PG* fields. */
export function poolConfig(db: typeof config.db): Record<string, unknown> {
  return db.url
    ? { connectionString: db.url }
    : { host: db.host, port: db.port, user: db.user, password: db.password, database: db.database };
}

/** node-postgres returns BIGINT / NUMERIC as strings; the catalog only stores
 *  small integers there, so parse them as numbers for the rest of the code. */
export function bigintAsNumber(v: string | null): number | null {
  return v === null ? null : Number(v);
}

// Stryker disable all: realBackend() is thin wiring onto `pg.Pool` that only
// runs against a live PostgreSQL server (CI / production). Its testable pieces -
// poolConfig() and bigintAsNumber() - are extracted above and covered directly.
export async function realBackend(): Promise<Backend> {
  const pg = (await import('pg')).default;

  pg.types.setTypeParser(20, bigintAsNumber); // int8
  pg.types.setTypeParser(1700, bigintAsNumber); // numeric

  const pool = new pg.Pool(poolConfig(config.db));
  pool.on('error', (err) => {
    console.error('unexpected postgres pool error', err);
  });
  return {
    query: (text, values) => pool.query(text, values),
    connect: () => pool.connect(),
    end: () => pool.end(),
    execScript: (sql) => pool.query(sql),
  };
}
// Stryker restore all

// Stryker disable next-line ConditionalExpression: under SOPDS_TEST_DB=mem the
// `true` mutant is a no-op; the `!== 'mem'` mutant is killed (tests hit no real PG).
export const backend: Backend = process.env.SOPDS_TEST_DB === 'mem' ? await memoryBackend() : await realBackend();
