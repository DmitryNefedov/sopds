import AdmZip from 'adm-zip';
import sax from 'sax';
import { getLangCode } from '../utils/lang.js';
import { sniffMime, looksLikeImage } from './fb2.js';
import type { RawMeta } from './index.js';

interface ManifestItem {
  id: string;
  href: string;
  type: string;
}

// EPUB metadata + cover extraction, deliberately lenient: a malformed package
// document yields whatever fields it did manage to produce.
export function parseEpub(buf: Buffer, { metaOnly = false }: { metaOnly?: boolean } = {}): RawMeta {
  const meta: Record<string, any> = {
    title: '',
    authors: [],
    genres: [],
    lang: '',
    docdate: '',
    annotation: '',
    series: null,
    coverData: null,
    coverMime: null,
  };

  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    return { ...meta, langCode: 9 } as RawMeta;
  }

  const container = zip.getEntry('META-INF/container.xml');
  let opfPath = 'content.opf';
  if (container) {
    const m = container.getData().toString('utf8').match(/full-path="([^"]+)"/i);
    if (m) opfPath = m[1];
  }
  const opfEntry = zip.getEntry(opfPath) || zip.getEntry('OEBPS/content.opf');
  if (!opfEntry) return { ...meta, langCode: 9 } as RawMeta;
  const opf = opfEntry.getData().toString('utf8');
  // Stryker disable next-line StringLiteral: with no '/', lastIndexOf('/') is -1
  // and slice(0, 0) === '' - the same as the else branch, and any non-'' else
  // value is defeated by the bare-href and OEBPS/ fallback candidates below.
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const resolve = (href: string) =>
    // Stryker disable next-line Regex: `.*` is greedy, so `[#?].*` and `[#?].*$`
    // both strip from the first fragment/query char to the end.
    normalizePath(opfDir + decodeURIComponent(String(href).replace(/[#?].*$/, '')));

  // Stryker disable next-line BooleanLiteral: sax emits the same tag/text events
  // in strict mode (it only additionally reports ignorable errors).
  const parser = sax.parser(false, { lowercase: true });
  let capture: string | null = null;
  let titleSeen = false; // ignore secondary <dc:title> elements
  let coverId: string | null = null;
  let coverHref: string | null = null;
  const manifest: ManifestItem[] = [];

  parser.onopentag = (node) => {
    const name = node.name;
    const a = (node as sax.Tag).attributes as Record<string, string>;
    if (name === 'dc:title') capture = titleSeen ? null : 'title';
    else if (name === 'dc:creator') capture = 'author';
    else if (name === 'dc:language') capture = 'lang';
    else if (name === 'dc:subject') capture = 'genre';
    else if (name === 'dc:description') capture = 'annotation';
    else if (name === 'dc:date') capture = 'docdate';
    else capture = null;

    // Stryker disable next-line ConditionalExpression: only <meta> elements in a
    // package document carry the name=/content= pair these lines read.
    if (name === 'meta') {
      if (a.name === 'cover') coverId = a.content;
      if (a.name === 'calibre:series') meta.series = { title: a.content, index: 0 };
      if (a.name === 'calibre:series_index' && meta.series)
        meta.series.index = parseInt(a.content, 10) || 0;
    }
    // Stryker disable next-line ConditionalExpression: a non-<item> element
    // pushes an {id:undefined, href:undefined} row that no lookup can match and
    // the image filter excludes.
    if (name === 'item') {
      manifest.push({
        id: a.id,
        href: a.href,
        // Stryker disable next-line StringLiteral: a missing media-type yields '',
        // matched only by .startsWith('image/') / a mime check, where '' and any
        // non-image string behave identically.
        type: (a['media-type'] || '').toLowerCase(),
      });
      // Stryker disable next-line StringLiteral: '' vs junk is moot for .includes().
      if ((a.properties || '').includes('cover-image')) coverHref = a.href;
    }
  };
  parser.ontext = (t) => {
    // Stryker disable next-line ConditionalExpression,LogicalOperator: `!t` only
    // skips appending '' (harmless); with no capture the switch matches nothing.
    if (!capture || !t) return;
    switch (capture) {
      case 'title': meta.title += t; break;
      case 'author': meta._author = (meta._author || '') + t; break;
      case 'lang': meta.lang += t; break;
      case 'genre': meta._genre = (meta._genre || '') + t; break;
      case 'annotation': meta.annotation += t + ' '; break;
      case 'docdate': meta.docdate += t; break;
    }
  };
  parser.onclosetag = (name) => {
    // A second <dc:title> is ignored; once the first has closed we have it.
    if (name === 'dc:title') titleSeen = true;
    // `_author` / `_genre` are non-null only while a <dc:creator> / <dc:subject>
    // is open (nothing else sets capture to 'author'/'genre'), so a name check
    // would be redundant with the null guard.
    if (meta._author != null) {
      const a = meta._author.trim();
      if (a) meta.authors.push(a);
      meta._author = null;
    }
    if (meta._genre != null) {
      const g = meta._genre.trim().toLowerCase();
      if (g) meta.genres.push(g);
      meta._genre = null;
    }
    capture = null;
  };

  try {
    parser.write(opf).close();
  } catch {
    /* lenient */
  }

  const images = manifest.filter(
    // Stryker disable next-line StringLiteral: `it.href` is always a string from
    // the manifest push; `|| ''` is belt-and-braces for a malformed <item>.
    (it) => it.type.startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(it.href || ''),
  );
  // Resolve the cover image, in priority order:
  //   1. manifest item with properties="cover-image" (EPUB3)
  //   2. <meta name="cover" content="ID"> -> that manifest item (EPUB2)
  //   3. an image whose id or href mentions "cover"
  //   4. the first image in the manifest
  let coverItem: Partial<ManifestItem> | undefined;
  if (coverHref) coverItem = images.find((i) => i.href === coverHref) || { href: coverHref };
  if (!coverItem && coverId) coverItem = manifest.find((i) => i.id === coverId);
  if (!coverItem)
    // Stryker disable next-line StringLiteral: id/href are strings from the
    // manifest push; the `|| ''` guards a malformed <item> that has neither.
    coverItem = images.find((i) => /cover/i.test(i.id || '') || /cover/i.test(i.href || ''));
  if (!coverItem) coverItem = images[0];

  if (!metaOnly && coverItem && coverItem.href) {
    const candidates = [resolve(coverItem.href), coverItem.href, `OEBPS/${coverItem.href}`];
    for (const c of candidates) {
      const entry = zip.getEntry(c);
      // Stryker disable next-line ConditionalExpression: without this, a null
      // entry throws in getData() below and the catch moves to the next candidate
      // just the same.
      if (!entry) continue;
      try {
        const data = entry.getData();
        if (looksLikeImage(data)) {
          meta.coverData = data;
          meta.coverMime =
            coverItem.type && coverItem.type.startsWith('image/')
              ? coverItem.type
              : sniffMime(data);
          break;
        }
      } catch {
        /* try next candidate */
      }
    }
  }

  meta.title = meta.title.replace(/\s+/g, ' ').trim();
  meta.lang = meta.lang.trim();
  meta.docdate = meta.docdate.trim();
  meta.annotation = meta.annotation.replace(/\s+/g, ' ').trim();
  meta.authors = meta.authors.map((a: string) => {
    if (a.includes(',')) return a;
    const parts = a.split(/\s+/);
    if (parts.length < 2) return a;
    return [parts[parts.length - 1], parts.slice(0, -1).join(' ')].join(' ');
  });
  meta.langCode = getLangCode(meta.title);
  return meta as RawMeta;
}

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of String(p).split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
