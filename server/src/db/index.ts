import { backend } from './backend.js';
import type { RawRunner } from './backend.js';

// The query surface the rest of the server talks to. Statements are written
// with `?` / `@name` placeholders and translated to Postgres' `$n` here.

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

/** Rewrite `?` / `@name` placeholders into `$n` and order the bind values to
 *  match. Bulk statements are written in native `$n` form and pass through. */
function translate(sql: string, params: Params | undefined): { text: string; values: unknown[] } {
  if (params == null) return { text: sql, values: [] };

  if (Array.isArray(params)) {
    let i = 0;
    const text = sql.replace(/\?/g, () => `$${++i}`);
    return { text, values: params.map(coerce) };
  }

  // Object params: @name / :name, each distinct name bound once. `::` is
  // matched first so a Postgres cast is never mistaken for a parameter.
  const values: unknown[] = [];
  const index = new Map<string, number>();
  const text = sql.replace(/::|[@:]([a-zA-Z_][a-zA-Z0-9_]*)/g, (whole, name?: string) => {
    if (name === undefined) return whole;
    if (!index.has(name)) {
      values.push(coerce(params[name]));
      index.set(name, values.length);
    }
    return `$${index.get(name)}`;
  });
  return { text, values };
}

/** Callers occasionally pass booleans or undefined; the schema stores 0/1
 *  integers and Postgres rejects undefined. */
function coerce(v: SqlParam): SqlParam {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

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

export default db;
