import sax from 'sax';
import { getLangCode } from '../lang.js';

// Decode an FB2 buffer to a string, honouring the XML encoding declaration
// (Russian FB2 files are very often windows-1251, not UTF-8).
export function decodeXmlBuffer(buf) {
  let bom = null;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom = 'utf-8';
  else if (buf[0] === 0xff && buf[1] === 0xfe) bom = 'utf-16le';
  else if (buf[0] === 0xfe && buf[1] === 0xff) bom = 'utf-16be';
  const head = buf.subarray(0, 200).toString('latin1');
  const m = head.match(/encoding=["']([\w-]+)["']/i);
  let enc = (bom || (m ? m[1] : 'utf-8')).toLowerCase();
  if (enc === 'utf8' || enc === 'us-ascii' || enc === 'ascii') enc = 'utf-8';
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

const IMAGE_MIME = /^image\//i;

// Streaming FB2 metadata + cover extraction. Ported from book_tools/format/fb2sax.py.
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
    coverMime: null,
  };

  const text = decodeXmlBuffer(buf);
  const parser = sax.parser(false, { lowercase: true, trim: false });

  const stack = [];
  let curFirst = '';
  let curLast = '';
  let capture = null;
  let inBinary = false;
  let binaryId = null;
  let binaryType = null;
  let binaryChunks = [];
  let doneDescription = false;
  const images = []; // { id, mime, b64 } collected in document order

  const path = () => stack.join('/');

  parser.onopentag = (node) => {
    stack.push(node.name);
    const p = path();

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
      // Only "#id" references point at an embedded <binary>.
      if (href.startsWith('#')) meta.coverId = href.slice(1).toLowerCase();
    }
    if (node.name === 'binary') {
      binaryId = (node.attributes.id || '').toLowerCase();
      binaryType = (node.attributes['content-type'] || '').toLowerCase();
      inBinary = true;
      binaryChunks = [];
    }
  };

  parser.ontext = (t) => {
    if (inBinary) {
      binaryChunks.push(t);
      return;
    }
    if (doneDescription || !capture) return;
    switch (capture) {
      case 'first': curFirst += t; break;
      case 'last': curLast += t; break;
      case 'title': meta.title += t; break;
      case 'lang': meta.lang += t; break;
      case 'genre': meta._genre = (meta._genre || '') + t; break;
      case 'docdate': if (!meta.docdate) meta._docdate = (meta._docdate || '') + t; break;
      case 'annotation': meta.annotation += t + ' '; break;
    }
  };

  parser.onclosetag = (name) => {
    const p = path();
    if (name === 'author' && p.includes('title-info')) {
      const full = [curFirst.trim(), curLast.trim()].filter(Boolean).join(' ');
      if (full) meta.authors.push(full);
      curFirst = '';
      curLast = '';
    }
    if (name === 'genre' && meta._genre) {
      meta.genres.push(meta._genre.trim().toLowerCase());
      meta._genre = '';
    }
    if (name === 'binary') {
      if (binaryId) {
        images.push({ id: binaryId, mime: binaryType, b64: binaryChunks.join('') });
      }
      inBinary = false;
      binaryId = null;
      binaryType = null;
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

  // Resolve the cover: the referenced binary, else the first image binary,
  // else the first binary whose id looks like a cover.
  const decode = (b64) => {
    const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
    if (!clean) return null;
    const data = Buffer.from(clean, 'base64');
    return data.length > 32 ? data : null;
  };
  let chosen =
    (meta.coverId && images.find((i) => i.id === meta.coverId)) ||
    images.find((i) => IMAGE_MIME.test(i.mime)) ||
    images.find((i) => /cover/i.test(i.id)) ||
    images[0];
  if (chosen) {
    const data = decode(chosen.b64);
    if (data && looksLikeImage(data)) {
      meta.coverData = data;
      meta.coverMime = chosen.mime && IMAGE_MIME.test(chosen.mime)
        ? chosen.mime
        : sniffMime(data);
    }
  }

  if (!meta.docdate && meta._docdate) meta.docdate = meta._docdate.trim();
  meta.title = meta.title.trim();
  meta.lang = meta.lang.trim();
  meta.annotation = meta.annotation.replace(/\s+/g, ' ').trim();
  meta.langCode = getLangCode(meta.title);

  meta.authors = meta.authors.map((a) => {
    if (a.includes(',')) return a;
    const parts = a.split(/\s+/);
    if (parts.length < 2) return a;
    return [parts[parts.length - 1], parts.slice(0, -1).join(' ')].join(' ');
  });

  return meta;
}

export function looksLikeImage(buf) {
  return Boolean(sniffMime(buf));
}

export function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return 'image/png';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp';
  if (buf.toString('latin1', 0, 5).trim().startsWith('<svg') || buf.toString('latin1', 0, 5) === '<?xml')
    return 'image/svg+xml';
  return null;
}
