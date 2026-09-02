import db from './db.js';
import config from './config.js';

// Runtime-editable settings, persisted in the `settings` table and exposed
// through the admin page. Env vars / config.js provide the defaults.

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);

// group order is preserved for the UI
export const SETTING_DEFS = [
  // --- General -----------------------------------------------------------
  { key: 'title', group: 'General', type: 'text', default: config.title,
    label: 'Catalog title' },
  { key: 'subtitle', group: 'General', type: 'text', default: config.subtitle,
    label: 'Catalog subtitle' },
  { key: 'rootLib', group: 'General', type: 'text', default: config.rootLib,
    label: 'Book collection directory',
    help: 'Absolute path to the folder that holds your books' },
  { key: 'bookExtensions', group: 'General', type: 'text',
    default: config.bookExtensions.join(' '),
    label: 'Book file extensions',
    help: 'Space separated, lower-case, with the leading dot' },

  // --- Scanning --------------------------------------------------------
  { key: 'zipScan', group: 'Scanning', type: 'bool', default: config.zipScan,
    label: 'Scan .zip archives', help: 'Look inside .zip files for books' },
  { key: 'deleteMissing', group: 'Scanning', type: 'bool', default: true,
    label: 'Remove missing books',
    help: 'Delete catalog entries whose files disappeared since the last scan' },
  { key: 'scanEnabled', group: 'Scanning', type: 'bool', default: false,
    label: 'Enable scheduled scanning' },
  { key: 'scanCron', group: 'Scanning', type: 'cron', default: '0 0,12 * * *',
    label: 'Scan schedule (cron)',
    help: 'Five fields: minute hour day-of-month month day-of-week' },

  // --- Display --------------------------------------------------------
  { key: 'maxItems', group: 'Display', type: 'int', default: config.maxItems,
    label: 'Items per page', min: 1, max: 200 },
  { key: 'doublesHide', group: 'Display', type: 'bool', default: config.doublesHide,
    label: 'Hide duplicate books',
    help: 'Collapse books with the same title and authors in listings' },
  { key: 'coverShow', group: 'Display', type: 'bool', default: true,
    label: 'Show book covers' },

  // --- Conversion ----------------------------------------------------
  { key: 'ebookConvert', group: 'Conversion', type: 'text',
    default: config.ebookConvert,
    label: 'External converter (Calibre)',
    help: 'Path or command for `ebook-convert`; leave blank to always use the built-in converters' },
  { key: 'titleAsFilename', group: 'Conversion', type: 'bool', default: true,
    label: 'Name downloads after the book title' },
];

const DEF_BY_KEY = Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d]));

const getRow = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertRow = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);

function coerce(def, raw) {
  if (raw === undefined || raw === null) return def.default;
  switch (def.type) {
    case 'bool':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'int': {
      const n = parseInt(raw, 10);
      if (Number.isNaN(n)) return def.default;
      if (def.min != null && n < def.min) return def.min;
      if (def.max != null && n > def.max) return def.max;
      return n;
    }
    case 'cron':
    case 'text':
    default:
      return String(raw);
  }
}

const overrides = {}; // process-lifetime overrides (e.g. CLI --root)

export function setOverride(key, value) {
  overrides[key] = value;
}

export function get(key) {
  const def = DEF_BY_KEY[key];
  if (!def) throw new Error(`unknown setting: ${key}`);
  if (key in overrides) return coerce(def, overrides[key]);
  const row = getRow.get(key);
  if (!row) return def.default;
  try {
    return coerce(def, JSON.parse(row.value));
  } catch {
    return coerce(def, row.value);
  }
}

export function getAll() {
  const out = {};
  for (const d of SETTING_DEFS) out[d.key] = get(d.key);
  return out;
}

// Convenience typed helpers used across the codebase.
export const S = new Proxy(
  {},
  {
    get: (_t, prop) => get(String(prop)),
  },
);

export function setMany(patch) {
  const errors = {};
  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) {
    const def = DEF_BY_KEY[key];
    if (!def) {
      errors[key] = 'unknown setting';
      continue;
    }
    if (def.type === 'cron' && !isValidCron(String(value))) {
      errors[key] = 'invalid cron expression (expected 5 fields)';
      continue;
    }
    if (def.type === 'int' && Number.isNaN(parseInt(value, 10))) {
      errors[key] = 'expected a number';
      continue;
    }
    clean[key] = coerce(def, value);
  }
  if (Object.keys(errors).length) {
    const err = new Error('invalid settings');
    err.fields = errors;
    err.status = 400;
    throw err;
  }
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(clean)) {
      upsertRow.run(key, JSON.stringify(value));
    }
  });
  tx();
  listeners.forEach((fn) => {
    try {
      fn(clean);
    } catch {
      /* ignore listener errors */
    }
  });
  return getAll();
}

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// --- lightweight state that is written by the system, shown read-only ----

export function getState(key) {
  const row = getRow.get(`__state.${key}`);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}
export function setState(key, value) {
  upsertRow.run(`__state.${key}`, JSON.stringify(value));
}

// --- cron -------------------------------------------------------------

export function isValidCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return parts.every((p, i) => fieldValid(p, ranges[i][0], ranges[i][1]));
}

function fieldValid(field, lo, hi) {
  return field.split(',').every((token) => {
    const [range, stepStr] = token.split('/');
    if (stepStr !== undefined && (!/^\d+$/.test(stepStr) || Number(stepStr) < 1)) {
      return false;
    }
    if (range === '*') return true;
    const [a, b] = range.split('-');
    const na = Number(a);
    if (!/^\d+$/.test(a) || na < lo || na > hi) return false;
    if (b !== undefined) {
      const nb = Number(b);
      if (!/^\d+$/.test(b) || nb < lo || nb > hi) return false;
    }
    return true;
  });
}

// Returns true if `date` matches the cron expression.
export function cronMatches(expr, date = new Date()) {
  if (!isValidCron(expr)) return false;
  const parts = expr.trim().split(/\s+/);
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  return parts.every((field, i) => matchField(field, values[i], i));
}

function matchField(field, value, idx) {
  const [lo, hi] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ][idx];
  return field.split(',').some((token) => {
    const [range, stepStr] = token.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let start = lo;
    let end = hi;
    if (range !== '*') {
      const [a, b] = range.split('-');
      start = Number(a);
      end = b !== undefined ? Number(b) : Number(a);
    }
    for (let n = start; n <= end; n += step) {
      if (n === value) return true;
      // Sunday can be 0 or 7 for day-of-week
      if (idx === 4 && value === 0 && n === 7) return true;
      if (idx === 4 && value === 7 && n === 0) return true;
    }
    return false;
  });
}
