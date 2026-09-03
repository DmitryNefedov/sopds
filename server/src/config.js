import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.PORT) || 8000,
  // Network interface to bind. Defaults to all interfaces so the catalog is
  // reachable from other devices on the LAN (e-readers, tablets, …).
  // Set HOST=127.0.0.1 to restrict to localhost.
  host: process.env.HOST || '0.0.0.0',
  // Path to the sqlite database file.
  dbPath: process.env.SOPDS_DB || path.join(ROOT, 'data', 'sopds.db'),
  // Absolute path to the directory that holds the book collection.
  rootLib: process.env.SOPDS_ROOT_LIB || path.join(ROOT, 'books'),
  // Recognised book file extensions (lower case, with dot).
  bookExtensions: (process.env.SOPDS_BOOK_EXTENSIONS || '.fb2 .epub .mobi .pdf .djvu')
    .split(/\s+/)
    .filter(Boolean)
    .map((e) => e.toLowerCase()),
  // Scan .zip archives for books.
  zipScan: process.env.SOPDS_ZIPSCAN !== '0',
  // Max items returned per page.
  maxItems: Number(process.env.SOPDS_MAXITEMS) || 50,
  // Hide duplicate books (same title + same author set) in listings.
  doublesHide: process.env.SOPDS_DOUBLES_HIDE !== '0',
  // Public base URL used when building absolute links inside OPDS feeds.
  siteUrl: process.env.SOPDS_SITE_URL || '',
  title: process.env.SOPDS_TITLE || 'SimpleOPDS Catalog',
  subtitle: process.env.SOPDS_SUBTITLE || 'Powered by Node + React',
  rootDir: ROOT,
  // Formats the UI always offers for download; the server converts on demand.
  downloadFormats: ['fb2', 'epub', 'mobi'],
  // Optional external converter (Calibre). When set / found on PATH it is
  // preferred over the built-in converters. Empty string disables the lookup.
  ebookConvert:
    process.env.SOPDS_EBOOK_CONVERT !== undefined
      ? process.env.SOPDS_EBOOK_CONVERT
      : 'ebook-convert',
  convertCacheDir:
    process.env.SOPDS_CONVERT_CACHE ||
    path.join(ROOT, 'data', 'convert-cache'),
};

export default config;
