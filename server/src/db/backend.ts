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
  /** Run a multi-statement script (schema.sql) with no parameters. */
  execScript(sql: string): Promise<unknown>;
}

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
    end: () => lite.close(),
    execScript: (sql) => lite.exec(sql),
  };
}

async function realBackend(): Promise<Backend> {
  const pg = (await import('pg')).default;

  // node-postgres returns BIGINT / NUMERIC as strings. The catalog only stores
  // small integers there, so parse them as numbers for the rest of the code.
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
    end: () => pool.end(),
    execScript: (sql) => pool.query(sql),
  };
}

export const backend: Backend =
  process.env.SOPDS_TEST_DB === 'mem' ? await memoryBackend() : await realBackend();
