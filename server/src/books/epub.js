import AdmZip from 'adm-zip';
import sax from 'sax';
import { getLangCode } from '../lang.js';
import { sniffMime, looksLikeImage } from './fb2.js';

// EPUB metadata + cover extraction. Ported from book_tools/format/epub.py.
export function parseEpub(buf) {
  const meta = {
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

  let zip;
  try {
    zip = new AdmZip(buf);
  } catch {
    return { ...meta, langCode: 9 };
  }

  const container = zip.getEntry('META-INF/container.xml');
  let opfPath = 'content.opf';
  if (container) {
    const m = container.getData().toString('utf8').match(/full-path="([^"]+)"/i);
    if (m) opfPath = m[1];
  }
  const opfEntry = zip.getEntry(opfPath) || zip.getEntry('OEBPS/content.opf');
  if (!opfEntry) return { ...meta, langCode: 9 };
  const opf = opfEntry.getData().toString('utf8');
  const opfDir = opfPath.includes('/')
    ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1)
    : '';
  const resolve = (href) =>
    normalizePath(opfDir + decodeURIComponent(String(href).replace(/[#?].*$/, '')));

  const parser = sax.parser(false, { lowercase: true, trim: false });
  let capture = null;
  let titleSeen = false; // ignore secondary <dc:title> elements
  let coverId = null;
  let coverHref = null;
  const manifest = []; // { id, href, type, props }

  parser.onopentag = (node) => {
    const name = node.name;
    if (name === 'dc:title') capture = titleSeen ? null : 'title';
    else if (name === 'dc:creator') capture = 'author';
    else if (name === 'dc:language') capture = 'lang';
    else if (name === 'dc:subject') capture = 'genre';
    else if (name === 'dc:description') capture = 'annotation';
    else if (name === 'dc:date') capture = 'docdate';
    else capture = null;

    if (name === 'meta') {
      const a = node.attributes;
      if (a.name === 'cover') coverId = a.content;
      if (a.name === 'calibre:series') meta.series = { title: a.content, index: 0 };
      if (a.name === 'calibre:series_index' && meta.series)
        meta.series.index = parseInt(a.content, 10) || 0;
    }
    if (name === 'item') {
      const a = node.attributes;
      manifest.push({
        id: a.id,
        href: a.href,
        type: (a['media-type'] || '').toLowerCase(),
        props: a.properties || '',
      });
      if ((a.properties || '').includes('cover-image')) coverHref = a.href;
    }
  };
  parser.ontext = (t) => {
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
    if (name === 'dc:title' && capture === 'title') titleSeen = true;
    if (name === 'dc:creator' && meta._author != null) {
      const a = meta._author.trim();
      if (a) meta.authors.push(a);
      meta._author = null;
    }
    if (name === 'dc:subject' && meta._genre != null) {
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
    (it) => it.type.startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(it.href || ''),
  );
  // Resolve the cover image, in priority order:
  //   1. manifest item with properties="cover-image" (EPUB3)
  //   2. <meta name="cover" content="ID"> -> that manifest item (EPUB2)
  //   3. an image whose id or href mentions "cover"
  //   4. the first image in the manifest
  let coverItem = null;
  if (coverHref) coverItem = images.find((i) => i.href === coverHref) || { href: coverHref };
  if (!coverItem && coverId) coverItem = manifest.find((i) => i.id === coverId);
  if (!coverItem)
    coverItem = images.find((i) => /cover/i.test(i.id || '') || /cover/i.test(i.href || ''));
  if (!coverItem) coverItem = images[0];

  if (coverItem && coverItem.href) {
    const candidates = [resolve(coverItem.href), coverItem.href, `OEBPS/${coverItem.href}`];
    for (const c of candidates) {
      const entry = zip.getEntry(c);
      if (!entry) continue;
      try {
        const data = entry.getData();
        if (looksLikeImage(data)) {
          meta.coverData = data;
          meta.coverMime = coverItem.type && coverItem.type.startsWith('image/')
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
  meta.authors = meta.authors.map((a) => {
    if (a.includes(',')) return a;
    const parts = a.split(/\s+/);
    if (parts.length < 2) return a;
    return [parts[parts.length - 1], parts.slice(0, -1).join(' ')].join(' ');
  });
  meta.langCode = getLangCode(meta.title);
  return meta;
}

function normalizePath(p) {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
