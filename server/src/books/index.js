import path from 'node:path';
import { parseFb2 } from './fb2.js';
import { parseEpub } from './epub.js';
import { mobiCover, mobiMeta } from './mobi.js';
import { getLangCode } from '../lang.js';

// Returns normalised book metadata for a supported file, or a minimal record
// derived from the filename for formats we cannot introspect (pdf, djvu, mobi).
export function parseBook(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (ext === '.fb2') return normalize(parseFb2(buf), filename);
    if (ext === '.epub') return normalize(parseEpub(buf), filename);
    if (ext === '.mobi') return normalize(mobiMeta(buf), filename);
  } catch {
    /* fall through to filename-only metadata */
  }
  const base = path.basename(filename, ext);
  return normalize(
    { title: base, authors: [], genres: [], lang: '', langCode: getLangCode(base) },
    filename,
  );
}

// Returns { data: Buffer, mime: string } for the embedded cover, or null.
export function extractCover(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (ext === '.fb2') {
      const m = parseFb2(buf);
      return m.coverData ? { data: m.coverData, mime: m.coverMime || 'image/jpeg' } : null;
    }
    if (ext === '.epub') {
      const m = parseEpub(buf);
      return m.coverData ? { data: m.coverData, mime: m.coverMime || 'image/jpeg' } : null;
    }
    if (ext === '.mobi') return mobiCover(buf);
  } catch {
    /* ignore */
  }
  return null;
}

function normalize(meta, filename) {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext);
  return {
    title: (meta.title || base).slice(0, 512),
    authors: (meta.authors || []).filter(Boolean),
    genres: (meta.genres || []).filter(Boolean),
    series: meta.series && meta.series.title ? meta.series : null,
    lang: meta.lang || '',
    docdate: meta.docdate || '',
    annotation: (meta.annotation || '').slice(0, 10000),
    langCode: meta.langCode ?? getLangCode(meta.title || base),
    format: ext.replace('.', ''),
  };
}
