import sax from 'sax';
import { getLangCode } from '../lang.js';

// Streaming FB2 metadata + cover extraction. Ported from book_tools/format/fb2sax.py.
// `buf` is the full file contents as a Buffer.
export function parseFb2(buf) {
  const meta = {
    title: '',
    authors: [],
    genres: [],
    lang: '',
    docdate: '',
    annotation: '',
    series: null,
    coverId: null,
    coverData: null,
  };

  const text = buf.toString('utf8');
  const parser = sax.parser(false, { lowercase: true, trim: false });

  const stack = [];
  let curFirst = '';
  let curLast = '';
  let inAuthor = false;
  let capture = null; // key of meta field currently collecting text
  let inBinary = false;
  let binaryId = null;
  let binaryChunks = [];
  let doneDescription = false;

  const path = () => stack.join('/');

  parser.onopentag = (node) => {
    stack.push(node.name);
    const p = path();

    if (p.endsWith('title-info/author')) inAuthor = true;
    if (p.endsWith('title-info/author/first-name')) capture = 'first';
    else if (p.endsWith('title-info/author/last-name')) capture = 'last';
    else if (p.endsWith('title-info/book-title')) capture = 'title';
    else if (p.endsWith('title-info/lang')) capture = 'lang';
    else if (p.endsWith('title-info/genre')) capture = 'genre';
    else if (p.endsWith('document-info/date')) {
      capture = 'docdate';
      if (node.attributes.value) meta.docdate = node.attributes.value;
    } else if (p.includes('annotation')) capture = 'annotation';
    else capture = null;

    if (p.endsWith('title-info/sequence')) {
      const name = node.attributes.name;
      if (name) {
        meta.series = {
          title: name.trim(),
          index: parseInt(node.attributes.number, 10) || 0,
        };
      }
    }
    if (p.endsWith('title-info/coverpage/image')) {
      const href =
        node.attributes['l:href'] || node.attributes['xlink:href'] || '';
      if (href.startsWith('#')) meta.coverId = href.slice(1).toLowerCase();
    }
    if (node.name === 'binary') {
      binaryId = (node.attributes.id || '').toLowerCase();
      inBinary = true;
      binaryChunks = [];
    }
  };

  parser.ontext = (t) => {
    if (inBinary) {
      binaryChunks.push(t);
      return;
    }
    if (doneDescription) return;
    if (!capture) return;
    switch (capture) {
      case 'first':
        curFirst += t;
        break;
      case 'last':
        curLast += t;
        break;
      case 'title':
        meta.title += t;
        break;
      case 'lang':
        meta.lang += t;
        break;
      case 'genre':
        meta._genre = (meta._genre || '') + t;
        break;
      case 'docdate':
        if (!meta.docdate) meta._docdate = (meta._docdate || '') + t;
        break;
      case 'annotation':
        meta.annotation += t + ' ';
        break;
    }
  };

  parser.onclosetag = (name) => {
    const p = path();
    if (name === 'author' && p.includes('title-info')) {
      const full = [curFirst.trim(), curLast.trim()].filter(Boolean).join(' ');
      if (full) meta.authors.push(full);
      curFirst = '';
      curLast = '';
      inAuthor = false;
    }
    if (name === 'genre' && meta._genre) {
      meta.genres.push(meta._genre.trim().toLowerCase());
      meta._genre = '';
    }
    if (name === 'binary') {
      if (
        meta.coverId &&
        binaryId === meta.coverId &&
        !meta.coverData
      ) {
        try {
          meta.coverData = Buffer.from(binaryChunks.join('').trim(), 'base64');
        } catch {
          meta.coverData = null;
        }
      } else if (!meta.coverId && !meta.coverData && /image/i.test(binaryId || '')) {
        // Fallback: first image binary when no explicit coverpage.
      }
      inBinary = false;
      binaryId = null;
      binaryChunks = [];
    }
    if (name === 'description') doneDescription = true;
    stack.pop();
  };

  try {
    parser.write(text).close();
  } catch {
    /* be lenient with malformed FB2 */
  }

  if (!meta.docdate && meta._docdate) meta.docdate = meta._docdate.trim();
  meta.title = meta.title.trim();
  meta.lang = meta.lang.trim();
  meta.annotation = meta.annotation.replace(/\s+/g, ' ').trim();
  meta.langCode = getLangCode(meta.title);

  // Normalise "First Last" -> "Last First" for author display, matching the
  // original scanner behaviour.
  meta.authors = meta.authors.map((a) => {
    if (a.includes(',')) return a;
    const parts = a.split(/\s+/);
    if (parts.length < 2) return a;
    return [parts[parts.length - 1], parts.slice(0, -1).join(' ')].join(' ');
  });

  return meta;
}
