import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import config from './config.js';
import { S } from './settings.js';
import { extractCover } from './books/index.js';
import { readZipEntry } from './zip.js';
import type { Book, CoverImage } from './types.js';

const CAT_NORMAL = 0;

const MIME: Record<string, string> = {
  fb2: 'application/fb2+xml',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  pdf: 'application/pdf',
  djvu: 'image/vnd.djvu',
  zip: 'application/zip',
};

export function mimeFor(fmt: string): string {
  return MIME[fmt] || 'application/octet-stream';
}

/** A book identified by just the fields needed to locate its bytes on disk. */
type BookRef = Pick<Book, 'path' | 'filename' | 'cat_type'>;

// Returns a Buffer with the raw book bytes, or throws if the file is missing.
// For books inside a .zip only the requested entry is inflated — the archive is
// never expanded to disk or read whole into memory.
export async function readBookBytes(book: BookRef): Promise<Buffer> {
  const full = path.join(S.rootLib, book.path);
  if (book.cat_type === CAT_NORMAL) {
    return fs.promises.readFile(path.join(full, book.filename));
  }
  // zip archive: book.path is the archive, book.filename the entry
  return readZipEntry(full, book.filename);
}

export async function readBookCover(book: BookRef): Promise<CoverImage | null> {
  try {
    const buf = await readBookBytes(book);
    return extractCover(buf, book.filename);
  } catch {
    return null;
  }
}

export function zipWrap(buf: Buffer, name: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(name, buf);
  return zip.toBuffer();
}

export function gzip(buf: Buffer): Buffer {
  return zlib.gzipSync(buf);
}

// Transliterate a Russian title into an ASCII-safe download filename.
const TR1: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', з: 'z', и: 'i',
  й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ы: 'y', э: 'e', ж: 'zh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'sch', ю: 'ju', я: 'ja', ъ: '', ь: '',
};
export function translitName(s: string): string {
  let out = '';
  for (const ch of (s || '').toLowerCase()) {
    if (TR1[ch] !== undefined) out += TR1[ch];
    else if (/[a-z0-9._-]/i.test(ch)) out += ch;
    else if (ch === ' ') out += '_';
  }
  return out.replace(/_+/g, '_').replace(/^_|_$/g, '') || 'book';
}

// The placeholder shown for books with no embedded cover. The e-ink UI
// greyscales it with a CSS filter like every other cover, so there is only one.
interface NoCover {
  data: Buffer;
  type: string;
}
let _nocover: NoCover | null | undefined;
export function nocover(): NoCover | null {
  if (_nocover !== undefined) return _nocover;
  const dir = path.join(config.rootDir, 'assets');
  const candidates: Array<[string, string]> = [
    ['nocover.png', 'image/png'],
    ['nocover.svg', 'image/svg+xml'],
    ['nocover.jpg', 'image/jpeg'],
  ];
  _nocover = null;
  for (const [name, type] of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      _nocover = { data: fs.readFileSync(p), type };
      break;
    }
  }
  return _nocover;
}
