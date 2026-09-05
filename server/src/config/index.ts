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

export const config: Config = {
  port: Number(process.env.PORT) || 8000,
  // Network interface to bind; all interfaces by default, so e-readers and
  // tablets on the LAN can reach the catalog. HOST=127.0.0.1 restricts it.
  host: process.env.HOST || '0.0.0.0',
  // PostgreSQL connection. DATABASE_URL wins; otherwise the discrete PG* vars
  // (the same names the official postgres image and libpq use).
  db: {
    url: process.env.DATABASE_URL || '',
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'sopds',
    password: process.env.PGPASSWORD || 'sopds',
    database: process.env.PGDATABASE || 'sopds',
  },
  // Absolute path to the directory that holds the book collection.
  rootLib: process.env.SOPDS_ROOT_LIB || path.join(SERVER_ROOT, 'books'),
  // Recognised book file extensions (lower case, with dot).
  bookExtensions: (process.env.SOPDS_BOOK_EXTENSIONS || '.fb2 .epub .mobi .pdf .djvu')
    .split(/\s+/)
    .filter(Boolean)
    .map((e) => e.toLowerCase()),
  // Scan .zip archives for books.
  zipScan: process.env.SOPDS_ZIPSCAN !== '0',
  // Commit (and publish) books to the catalog every N additions during a scan,
  // rather than in one transaction at the end. Keeps a 700k-book first scan from
  // holding a giant transaction and makes books searchable while it runs.
  scanBatchSize: Number(process.env.SOPDS_SCAN_BATCH_SIZE) || 1000,
  scanConcurrency: Number(process.env.SOPDS_SCAN_CONCURRENCY) || 0,
  // Max items returned per page.
  maxItems: Number(process.env.SOPDS_MAXITEMS) || 50,
  // Hide duplicate books (same title + same author set) in listings.
  doublesHide: process.env.SOPDS_DOUBLES_HIDE !== '0',
  // Public base URL used when building absolute links inside OPDS feeds.
  siteUrl: process.env.SOPDS_SITE_URL || '',
  title: process.env.SOPDS_TITLE || 'SimpleOPDS Catalog',
  subtitle: process.env.SOPDS_SUBTITLE || 'Powered by Node + React',
  rootDir: SERVER_ROOT,
  // Formats the UI always offers for download; the server converts on demand.
  downloadFormats: ['fb2', 'epub', 'mobi'],
  // Optional external converter (Calibre), preferred over the built-in ones
  // when found. An empty string disables the lookup.
  ebookConvert:
    process.env.SOPDS_EBOOK_CONVERT !== undefined
      ? process.env.SOPDS_EBOOK_CONVERT
      : 'ebook-convert',
  convertCacheDir:
    process.env.SOPDS_CONVERT_CACHE || path.join(SERVER_ROOT, 'data', 'convert-cache'),
};

export default config;
