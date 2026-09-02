import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.PORT) || 8000,
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
};

export default config;
