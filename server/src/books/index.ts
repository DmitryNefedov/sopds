import path from 'node:path';
import { parseFb2 } from './fb2.js';
import { parseEpub } from './epub.js';
import { mobiCover, mobiMeta } from './mobi.js';
import { getLangCode } from '../lang.js';
import type { BookMeta, CoverImage } from '../types.js';

/** Raw output of a per-format parser, before normalisation. */
export interface RawMeta {
  title?: string;
  authors?: string[];
  genres?: string[];
  series?: { title?: string; index?: number } | null;
  lang?: string;
  docdate?: string;
  annotation?: string;
  langCode?: number;
  coverData?: Buffer | null;
  coverMime?: string;
}

export interface ParseOptions {
  /**
   * Metadata only: do not decode an embedded cover, and for FB2 read no
   * further than `</description>`. The scanner sets this — it stores no cover
   * bytes, and `extractCover` re-reads the file on demand — which is what
   * makes a full-collection walk cheap. `buf` may then be a *prefix* of the
   * file rather than the whole of it.
   */
  metaOnly?: boolean;
}

// Returns normalised book metadata for a supported file, or a minimal record
// derived from the filename for formats we cannot introspect (pdf, djvu, mobi).
export function parseBook(buf: Buffer, filename: string, opts: ParseOptions = {}): BookMeta {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (ext === '.fb2') return normalize(parseFb2(buf, opts), filename);
    if (ext === '.epub') return normalize(parseEpub(buf, opts), filename);
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
export function extractCover(buf: Buffer, filename: string): CoverImage | null {
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

function normalize(meta: RawMeta, filename: string): BookMeta {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext);
  const series =
    meta.series && meta.series.title
      ? { title: meta.series.title, index: meta.series.index }
      : null;
  return {
    title: (meta.title || base).slice(0, 512),
    authors: (meta.authors || []).filter(Boolean),
    genres: (meta.genres || []).filter(Boolean),
    series,
    lang: meta.lang || '',
    docdate: meta.docdate || '',
    annotation: (meta.annotation || '').slice(0, 10000),
    langCode: meta.langCode ?? getLangCode(meta.title || base),
    format: ext.replace('.', ''),
  };
}
