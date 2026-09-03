import db from './db.js';
import config from './config.js';
import { isValidCron } from './cron.js';

// Runtime-editable settings, persisted in the `settings` table (created in
// schema.sql) and exposed through the admin page. Env vars / config.js provide
// the defaults.
//
// Reads go through a synchronous in-memory cache so the `S.*` accessor stays
// synchronous everywhere it is used. `loadSettings()` must run once at startup
// (bin scripts and index.js call it); writes update both the database and the
// cache.

export type SettingType = 'text' | 'bool' | 'int' | 'cron';

export interface SettingDef {
  key: SettingKey;
  group: string;
  type: SettingType;
  default: string | number | boolean;
  label: string;
  help?: string;
  min?: number;
  max?: number;
}

/** The shape of a fully-resolved settings bag. Keep in sync with SETTING_DEFS. */
export interface Settings {
  title: string;
  subtitle: string;
  rootLib: string;
  bookExtensions: string;
  zipScan: boolean;
  scanBatchSize: number;
  scanConcurrency: number;
  deleteMissing: boolean;
  scanEnabled: boolean;
  scanCron: string;
  watchEnabled: boolean;
  watchDebounce: number;
  maxItems: number;
  doublesHide: boolean;
  coverShow: boolean;
  ebookConvert: string;
  titleAsFilename: boolean;
}

export type SettingKey = keyof Settings;

// group order is preserved for the UI
export const SETTING_DEFS: SettingDef[] = [
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
  { key: 'scanBatchSize', group: 'Scanning', type: 'int', default: config.scanBatchSize,
    min: 1, max: 1_000_000, label: 'Publish books every N added',
    help: 'During a scan, commit and make books available in batches of this size instead of waiting for the whole scan to finish' },
  { key: 'scanConcurrency', group: 'Scanning', type: 'int', default: config.scanConcurrency,
    min: 0, max: 64, label: 'Parallel readers',
    help: 'How many archives/folders to read at once. Decompression runs off the main thread, so raising this uses more cores. 0 picks a value from the available CPUs' },
  { key: 'deleteMissing', group: 'Scanning', type: 'bool', default: true,
    label: 'Remove missing books',
    help: 'Delete catalog entries whose files disappeared since the last scan' },
  { key: 'scanEnabled', group: 'Scanning', type: 'bool', default: false,
    label: 'Enable scheduled scanning' },
  { key: 'scanCron', group: 'Scanning', type: 'cron', default: '0 0,12 * * *',
    label: 'Scan schedule (cron)',
    help: 'Five fields: minute hour day-of-month month day-of-week' },
  { key: 'watchEnabled', group: 'Scanning', type: 'bool', default: false,
    label: 'Watch the collection folder',
    help: 'Automatically rescan a few seconds after files are added, changed or removed' },
  { key: 'watchDebounce', group: 'Scanning', type: 'int', default: 5, min: 1, max: 3600,
    label: 'Watch settle time (seconds)',
    help: 'Wait this long after the last change before rescanning' },

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

const DEF_BY_KEY: Record<string, SettingDef> = Object.fromEntries(
  SETTING_DEFS.map((d) => [d.key, d]),
);

type SettingValue = string | number | boolean;

function coerce(def: SettingDef, raw: unknown): SettingValue {
  if (raw === undefined || raw === null) return def.default;
  switch (def.type) {
    case 'bool':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'int': {
      const n = parseInt(String(raw), 10);
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

// key -> raw stored string (JSON). `__state.*` lives here too.
const rawCache = new Map<string, string>();
let loaded = false;

const overrides: Partial<Record<SettingKey, unknown>> = {};

export function setOverride(key: SettingKey, value: unknown): void {
  overrides[key] = value;
}

export async function loadSettings(): Promise<void> {
  const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  rawCache.clear();
  for (const r of rows) rawCache.set(r.key, r.value);
  loaded = true;
}

function rawValue(key: string): unknown {
  const stored = rawCache.get(key);
  if (stored === undefined) return undefined;
  try {
    return JSON.parse(stored);
  } catch {
    return stored;
  }
}

export function get<K extends SettingKey>(key: K): Settings[K] {
  const def = DEF_BY_KEY[key];
  if (!def) throw new Error(`unknown setting: ${key}`);
  if (key in overrides) return coerce(def, overrides[key]) as Settings[K];
  const v = rawValue(key);
  if (v === undefined) return def.default as Settings[K];
  return coerce(def, v) as Settings[K];
}

export function getAll(): Settings {
  const out: Record<string, SettingValue> = {};
  for (const d of SETTING_DEFS) out[d.key] = get(d.key);
  return out as unknown as Settings;
}

/** Synchronous typed accessor used across the codebase. */
export const S: Readonly<Settings> = new Proxy({} as Settings, {
  get: (_t, prop: string) => get(prop as SettingKey),
});

export function isLoaded(): boolean {
  return loaded;
}

export class SettingsError extends Error {
  fields: Record<string, string>;
  status = 400;
  constructor(fields: Record<string, string>) {
    super('invalid settings');
    this.fields = fields;
  }
}

export type SettingsPatch = Partial<Record<SettingKey, unknown>>;

const listeners = new Set<(patch: Partial<Settings>) => void>();

export async function setMany(patch: SettingsPatch): Promise<Settings> {
  const errors: Record<string, string> = {};
  const clean: Record<string, SettingValue> = {};
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
    if (def.type === 'int' && Number.isNaN(parseInt(String(value), 10))) {
      errors[key] = 'expected a number';
      continue;
    }
    clean[key] = coerce(def, value);
  }
  if (Object.keys(errors).length) throw new SettingsError(errors);

  await db.tx(async (cx) => {
    for (const [key, value] of Object.entries(clean)) {
      const json = JSON.stringify(value);
      await cx.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, json],
      );
      rawCache.set(key, json);
    }
  });
  listeners.forEach((fn) => {
    try {
      fn(clean as Partial<Settings>);
    } catch {
      /* ignore listener errors */
    }
  });
  return getAll();
}

export function onChange(fn: (patch: Partial<Settings>) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// --- lightweight state that is written by the system, shown read-only ----

export function getState<T = unknown>(key: string): T | null {
  const v = rawValue(`__state.${key}`);
  return v === undefined ? null : (v as T);
}

export async function setState(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [`__state.${key}`, json],
  );
  rawCache.set(`__state.${key}`, json);
}
