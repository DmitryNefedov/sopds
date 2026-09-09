import path from 'node:path';
import { parseFb2, fb2Cover, FB2_HEAD_LIMIT, FB2_HEAD_MARKER } from './fb2.js';
import { parseEpub } from './epub.js';
import { mobiCover, mobiMeta } from './mobi.js';
import { getLangCode } from '../utils/lang.js';
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

/**
 * How much of a file `parseBook` needs to see, and all the scan reads.
 *
 *   fb2    head, to the end of the leading `<description>`
 *   mobi   head, PalmDB record 0 at the front of the file
 *   epub   all of it — a zip, central directory last
 *   else   nothing; the metadata comes from the filename
 */
export type ReadPlan =
  | { need: 'none' }
  | { need: 'head'; limit: number; stopAt?: Buffer }
  | { need: 'all' };

/** MOBI record 0 (header + EXTH) is a few KB in practice; this is slack. */
export const MOBI_HEAD_LIMIT = 256 * 1024;

export function metaReadPlan(filename: string): ReadPlan {
  switch (path.extname(filename).toLowerCase()) {
    case '.fb2':
      return { need: 'head', limit: FB2_HEAD_LIMIT, stopAt: FB2_HEAD_MARKER };
    case '.mobi':
      return { need: 'head', limit: MOBI_HEAD_LIMIT };
    case '.epub':
      return { need: 'all' };
    default:
      return { need: 'none' };
  }
}

/** Passed to `parseBook` for a `need: 'none'` format, which never reads it. */
export const NO_BYTES = Buffer.alloc(0);

export interface ParseOptions {
  /**
   * Metadata only: decode no cover, and clip FB2 at `</description>`, so `buf`
   * may be a prefix of the file. Set by the scanner, which stores no cover
   * bytes — `extractCover` re-reads the file on demand.
   */
  metaOnly?: boolean;
}

// Normalised metadata for a supported file, or a filename-derived record for
// formats we cannot introspect (pdf, djvu).
export function parseBook(buf: Buffer, filename: string, opts: ParseOptions = {}): BookMeta {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (ext === '.fb2') return normalize(parseFb2(buf, opts), filename);
    if (ext === '.epub') return normalize(parseEpub(buf, opts), filename);
    // Stryker disable next-line ConditionalExpression: for a non-mobi ext,
    // mobiMeta() bails on the header check and yields the same filename-derived
    // BookMeta the block below produces.
    if (ext === '.mobi') return normalize(mobiMeta(buf), filename);
  } catch {
    /* fall through to filename-only metadata */
  }
  const base = path.basename(filename, ext);
  return normalize(
    // Stryker disable next-line ObjectLiteral: normalize() defaults every field,
    // so {} produces the same result (title <- base, langCode <- getLangCode(base)).
    { title: base, authors: [], genres: [], lang: '', langCode: getLangCode(base) },
    filename,
  );
}

// Returns { data: Buffer, mime: string } for the embedded cover, or null.
export function extractCover(buf: Buffer, filename: string): CoverImage | null {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (ext === '.fb2') {
      // The byte scan handles the overwhelming majority; parseFb2 is the
      // fallback for files it cannot make sense of.
      const quick = fb2Cover(buf);
      // Stryker disable next-line ConditionalExpression: parseFb2 below resolves
      // the same cover for any well-formed FB2 the byte scan also handles.
      if (quick) return quick;
      const m = parseFb2(buf);
      // Stryker disable next-line StringLiteral,LogicalOperator: parseFb2 always
      // sets coverMime when it sets coverData - the '|| image/jpeg' is unreachable.
      return m.coverData ? { data: m.coverData, mime: m.coverMime || 'image/jpeg' } : null;
    }
    if (ext === '.epub') {
      const m = parseEpub(buf);
      // Stryker disable next-line StringLiteral,LogicalOperator: parseEpub sets
      // coverMime (a sniffed value at worst) whenever it sets coverData.
      return m.coverData ? { data: m.coverData, mime: m.coverMime || 'image/jpeg' } : null;
    }
    // Stryker disable next-line ConditionalExpression: mobiCover() self-guards on
    // the PalmDB/MOBI header and returns null for any non-mobi buffer.
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
    // Stryker disable next-line ArrayDeclaration,MethodExpression: every parser
    // returns an array of non-blank author strings (mobiMeta filters its own).
    authors: (meta.authors || []).filter(Boolean),
    // Stryker disable next-line ArrayDeclaration: every parser returns an array
    // (but mobiMeta CAN push a '' genre, so .filter(Boolean) is load-bearing).
    genres: (meta.genres || []).filter(Boolean),
    series,
    lang: meta.lang || '',
    docdate: meta.docdate || '',
    annotation: (meta.annotation || '').slice(0, 10000),
    // Stryker disable next-line ConditionalExpression,LogicalOperator: every
    // parser and the filename fallback set meta.langCode (a value in 1..9,
    // always truthy), so the getLangCode() tail is unreachable.
    langCode: meta.langCode ?? getLangCode(meta.title || base),
    format: ext.replace('.', ''),
  };
}
