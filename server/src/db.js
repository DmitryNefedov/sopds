import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const raw = new DatabaseSync(config.dbPath);
raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');

// Thin wrapper that gives us a better-sqlite3-ish surface on top of node:sqlite
// and a simple synchronous transaction helper.
const db = {
  _raw: raw,
  exec: (sql) => raw.exec(sql),
  prepare(sql) {
    const stmt = raw.prepare(sql);
    return {
      get: (...args) => stmt.get(...normalizeArgs(args)),
      all: (...args) => stmt.all(...normalizeArgs(args)),
      run: (...args) => {
        const r = stmt.run(...normalizeArgs(args));
        return {
          changes: Number(r.changes),
          lastInsertRowid: r.lastInsertRowid,
        };
      },
    };
  },
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try {
        const result = fn(...args);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    };
  },
};

// node:sqlite wants BigInt/number/string/null/Uint8Array; coerce booleans and
// undefined which callers occasionally pass.
function normalizeArgs(args) {
  return args.map((a) => {
    if (a && typeof a === 'object' && !ArrayBuffer.isView(a)) {
      const out = {};
      for (const [k, v] of Object.entries(a)) out[k] = coerce(v);
      return out;
    }
    return coerce(a);
  });
}
function coerce(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  raw.exec(schema);
  seedGenres();
}

// Ensure the schema exists before any module prepares a statement against it.
initSchema();

function seedGenres() {
  const have = db.prepare('SELECT COUNT(*) c FROM genres').get().c;
  if (have > 0) return;
  const fixturePath = path.join(__dirname, 'genres.json');
  if (!fs.existsSync(fixturePath)) return;
  const rows = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const insert = db.prepare(
    'INSERT OR IGNORE INTO genres (genre, section, subsection) VALUES (?, ?, ?)',
  );
  const tx = db.transaction((items) => {
    for (const it of items) {
      const f = it.fields || {};
      insert.run(f.genre, f.section || '', f.subsection || '');
    }
  });
  tx(rows);
}

export function updateCounters() {
  const set = db.prepare(
    `INSERT INTO counters (name, value, update_time) VALUES (?, ?, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, update_time = excluded.update_time`,
  );
  set.run('allbooks', db.prepare('SELECT COUNT(*) c FROM books').get().c);
  set.run('allcatalogs', db.prepare('SELECT COUNT(*) c FROM catalogs').get().c);
  set.run('allauthors', db.prepare('SELECT COUNT(*) c FROM authors').get().c);
  set.run('allgenres', db.prepare('SELECT COUNT(*) c FROM genres').get().c);
  set.run('allseries', db.prepare('SELECT COUNT(*) c FROM series').get().c);
}

export default db;
