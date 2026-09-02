import AdmZip from 'adm-zip';
import sax from 'sax';
import { getLangCode } from '../lang.js';

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
    const m = container
      .getData()
      .toString('utf8')
      .match(/full-path="([^"]+)"/);
    if (m) opfPath = m[1];
  }
  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) return { ...meta, langCode: 9 };
  const opf = opfEntry.getData().toString('utf8');
  const opfDir = opfPath.includes('/')
    ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1)
    : '';

  const parser = sax.parser(false, { lowercase: true, trim: true });
  const stack = [];
  let capture = null;
  let coverId = null;
  let coverHref = null;
  const manifest = {};

  parser.onopentag = (node) => {
    stack.push(node.name);
    const name = node.name;
    if (name === 'dc:title') capture = 'title';
    else if (name === 'dc:creator') capture = 'author';
    else if (name === 'dc:language') capture = 'lang';
    else if (name === 'dc:subject') capture = 'genre';
    else if (name === 'dc:description') capture = 'annotation';
    else if (name === 'dc:date') capture = 'docdate';
    else capture = null;

    if (name === 'meta') {
      if (node.attributes.name === 'cover') coverId = node.attributes.content;
      if (
        node.attributes.property === 'belongs-to-collection' &&
        !meta.series
      ) {
        meta._seriesPending = true;
      }
      if (node.attributes.name === 'calibre:series')
        meta.series = { title: node.attributes.content, index: 0 };
      if (node.attributes.name === 'calibre:series_index' && meta.series)
        meta.series.index = parseInt(node.attributes.content, 10) || 0;
    }
    if (name === 'item') {
      manifest[node.attributes.id] = node.attributes.href;
      if ((node.attributes.properties || '').includes('cover-image'))
        coverHref = node.attributes.href;
    }
  };
  parser.ontext = (t) => {
    if (!capture || !t) return;
    switch (capture) {
      case 'title':
        if (!meta.title) meta.title = t;
        break;
      case 'author':
        meta.authors.push(t);
        break;
      case 'lang':
        if (!meta.lang) meta.lang = t;
        break;
      case 'genre':
        meta.genres.push(t.toLowerCase());
        break;
      case 'annotation':
        meta.annotation += t + ' ';
        break;
      case 'docdate':
        if (!meta.docdate) meta.docdate = t;
        break;
    }
  };
  parser.onclosetag = () => {
    capture = null;
    stack.pop();
  };

  try {
    parser.write(opf).close();
  } catch {
    /* lenient */
  }

  if (!coverHref && coverId && manifest[coverId]) coverHref = manifest[coverId];
  if (coverHref) {
    const entry =
      zip.getEntry(opfDir + coverHref) || zip.getEntry(coverHref);
    if (entry) {
      try {
        meta.coverData = entry.getData();
      } catch {
        /* ignore */
      }
    }
  }

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
