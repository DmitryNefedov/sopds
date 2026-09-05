import fs from 'node:fs';
import path from 'node:path';
import config from '../config/index.js';
import { S } from '../services/settings.js';
import { extractCover } from '../formats/index.js';
import { readZipEntry, readZipEntryAt } from './zip.js';
import type { Book, BookRow, CoverImage } from '../types.js';

// Reading a catalogued book's bytes off the filesystem, whether it is a loose
// file or an entry inside a `.zip`.

const CAT_NORMAL = 0;

/** A book identified by just the fields needed to locate its bytes on disk.
 *  The `zip_*` columns are optional: rows catalogued before the scan recorded
 *  them simply take the slower path. */
export type BookRef = Pick<Book, 'path' | 'filename' | 'cat_type'> &
  Partial<Pick<BookRow, 'zip_offset' | 'zip_csize' | 'zip_method'>>;

/**
 * The raw book bytes, or a throw if the file is missing. For a book inside a
 * `.zip` only the one entry is inflated — the archive is never expanded to
 * disk or read whole into memory.
 */
export async function readBookBytes(book: BookRef): Promise<Buffer> {
  const full = path.join(S.rootLib, book.path);
  if (book.cat_type === CAT_NORMAL) {
    return fs.promises.readFile(path.join(full, book.filename));
  }
  // Zip archive: book.path is the archive, book.filename the entry. A recorded
  // location seeks straight to it; without one we walk the central directory.
  if (book.zip_offset != null && book.zip_csize != null && book.zip_method != null) {
    try {
      return await readZipEntryAt(full, {
        offset: Number(book.zip_offset),
        csize: Number(book.zip_csize),
        method: Number(book.zip_method),
      });
    } catch {
      // Archive rewritten since the scan: fall through and look it up by name.
    }
  }
  return readZipEntry(full, book.filename);
}

/** The book's embedded cover, or null when it has none or cannot be read. */
export async function readBookCover(book: BookRef): Promise<CoverImage | null> {
  try {
    const buf = await readBookBytes(book);
    return extractCover(buf, book.filename);
  } catch {
    return null;
  }
}

interface NoCover {
  data: Buffer;
  type: string;
}
let placeholder: NoCover | null | undefined;

/** The placeholder image served for books with no embedded cover, read from
 *  `assets/` once and cached. */
export function nocover(): NoCover | null {
  if (placeholder !== undefined) return placeholder;
  const dir = path.join(config.rootDir, 'assets');
  const candidates: Array<[string, string]> = [
    ['nocover.png', 'image/png'],
    ['nocover.svg', 'image/svg+xml'],
    ['nocover.jpg', 'image/jpeg'],
  ];
  placeholder = null;
  for (const [name, type] of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      placeholder = { data: fs.readFileSync(p), type };
      break;
    }
  }
  return placeholder;
}
