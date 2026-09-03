import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import config from './config.js';
import { S } from './settings.js';
import { extractCover } from './books/index.js';

const CAT_NORMAL = 0;

const MIME = {
  fb2: 'application/fb2+xml',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  pdf: 'application/pdf',
  djvu: 'image/vnd.djvu',
  zip: 'application/zip',
};

export function mimeFor(fmt) {
  return MIME[fmt] || 'application/octet-stream';
}

// Returns a Buffer with the raw book bytes, or throws if the file is missing.
export function readBookBytes(book) {
  const full = path.join(S.rootLib, book.path);
  if (book.cat_type === CAT_NORMAL) {
    return fs.readFileSync(path.join(full, book.filename));
  }
  // zip archive: book.path is the archive, book.filename the entry
  const zip = new AdmZip(full);
  const entry = zip.getEntry(book.filename);
  if (!entry) throw new Error('entry not found in archive');
  return entry.getData();
}

export function readBookCover(book) {
  try {
    const buf = readBookBytes(book);
    return extractCover(buf, book.filename);
  } catch {
    return null;
  }
}

export function zipWrap(buf, name) {
  const zip = new AdmZip();
  zip.addFile(name, buf);
  return zip.toBuffer();
}

export function gzip(buf) {
  return zlib.gzipSync(buf);
}

// Transliterate a Russian title into an ASCII-safe download filename.
const TR1 = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', з: 'z', и: 'i',
  й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ы: 'y', э: 'e', ж: 'zh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'sch', ю: 'ju', я: 'ja', ъ: '', ь: '',
};
export function translitName(s) {
  let out = '';
  for (const ch of (s || '').toLowerCase()) {
    if (TR1[ch] !== undefined) out += TR1[ch];
    else if (/[a-z0-9._-]/i.test(ch)) out += ch;
    else if (ch === ' ') out += '_';
  }
  return out.replace(/_+/g, '_').replace(/^_|_$/g, '') || 'book';
}

let _nocover;
export function nocover() {
  if (_nocover !== undefined) return _nocover;
  const dir = path.join(config.rootDir, 'assets');
  const candidates = [
    ['nocover.png', 'image/png'],
    ['nocover.svg', 'image/svg+xml'],
    ['nocover.jpg', 'image/jpeg'],
  ];
  for (const [name, type] of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      _nocover = { data: fs.readFileSync(p), type };
      return _nocover;
    }
  }
  _nocover = null;
  return _nocover;
}
