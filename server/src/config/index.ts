import path from 'node:path';
import { SERVER_ROOT } from './paths.js';

export interface DbConfig {
  url: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface Config {
  port: number;
  host: string;
  db: DbConfig;
  rootLib: string;
  bookExtensions: string[];
  zipScan: boolean;
  scanBatchSize: number;
  scanConcurrency: number;
  maxItems: number;
  doublesHide: boolean;
  siteUrl: string;
  title: string;
  subtitle: string;
  rootDir: string;
  downloadFormats: string[];
  ebookConvert: string;
  convertCacheDir: string;
}

/** Whitespace-separated extension list -> lower-cased tokens (with the dot). */
export function parseExtensions(raw: string | undefined): string[] {
  const tokens = (raw || '.fb2 .epub .mobi .pdf .djvu').toLowerCase().match(/\S+/g);
  return tokens ? tokens : [];
}

/**
 * Build the runtime config from an environment. Defaults to `process.env`;
 * pass an explicit environment to exercise the fallbacks in isolation.
 */
export function buildConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT) || 8000,
    // Network interface to bind; all interfaces by default, so e-readers and
    // tablets on the LAN can reach the catalog. HOST=127.0.0.1 restricts it.
    host: env.HOST || '0.0.0.0',
    // PostgreSQL connection. DATABASE_URL wins; otherwise the discrete PG* vars
    // (the same names the official postgres image and libpq use).
    db: {
      url: env.DATABASE_URL || '',
      host: env.PGHOST || 'localhost',
      port: Number(env.PGPORT) || 5432,
      user: env.PGUSER || 'sopds',
      password: env.PGPASSWORD || 'sopds',
      database: env.PGDATABASE || 'sopds',
    },
    // Absolute path to the directory that holds the book collection.
    rootLib: env.SOPDS_ROOT_LIB || path.join(SERVER_ROOT, 'books'),
    // Recognised book file extensions (lower case, with dot).
    bookExtensions: parseExtensions(env.SOPDS_BOOK_EXTENSIONS),
    // Scan .zip archives for books.
    zipScan: env.SOPDS_ZIPSCAN !== '0',
    // Commit (and publish) books to the catalog every N additions during a scan,
    // rather than in one transaction at the end. Keeps a 700k-book first scan
    // from holding a giant transaction and makes books searchable while it runs.
    scanBatchSize: Number(env.SOPDS_SCAN_BATCH_SIZE) || 1000,
    scanConcurrency: Number(env.SOPDS_SCAN_CONCURRENCY) || 0,
    // Max items returned per page.
    maxItems: Number(env.SOPDS_MAXITEMS) || 50,
    // Hide duplicate books (same title + same author set) in listings.
    doublesHide: env.SOPDS_DOUBLES_HIDE !== '0',
    // Public base URL used when building absolute links inside OPDS feeds.
    siteUrl: env.SOPDS_SITE_URL || '',
    title: env.SOPDS_TITLE || 'SimpleOPDS Catalog',
    subtitle: env.SOPDS_SUBTITLE || 'Powered by Node + React',
    rootDir: SERVER_ROOT,
    // Formats the UI always offers for download; the server converts on demand.
    downloadFormats: ['fb2', 'epub', 'mobi'],
    // Optional external converter (Calibre), preferred over the built-in ones
    // when found. An empty string disables the lookup.
    ebookConvert:
      env.SOPDS_EBOOK_CONVERT !== undefined ? env.SOPDS_EBOOK_CONVERT : 'ebook-convert',
    convertCacheDir:
      env.SOPDS_CONVERT_CACHE || path.join(SERVER_ROOT, 'data', 'convert-cache'),
  };
}

export const config: Config = buildConfig();

export default config;
