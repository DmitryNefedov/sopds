import sax from 'sax';
import {
  emptyIr,
  escapeXml,
  htmlToParagraphs,
  sanitizeHtml,
} from './ir.js';

// ---------------------------------------------------------------------------
// FB2 -> IR
// ---------------------------------------------------------------------------

const BLOCK_OPEN = {
  p: '<p>',
  subtitle: '<p class="subtitle">',
  'empty-line': '<br/>',
  title: '', // handled specially (becomes chapter/heading text)
  epigraph: '<blockquote>',
  cite: '<blockquote>',
  poem: '<blockquote>',
  stanza: '<p class="stanza">',
  v: '<span class="v"></span>',
  'text-author': '<p class="text-author">',
};
const BLOCK_CLOSE = {
  p: '</p>',
  subtitle: '</p>',
  epigraph: '</blockquote>',
  cite: '</blockquote>',
  poem: '</blockquote>',
  stanza: '</p>',
  'text-author': '</p>',
};
const INLINE = {
  emphasis: ['<em>', '</em>'],
  strong: ['<strong>', '</strong>'],
  strikethrough: ['<s>', '</s>'],
  sub: ['<sub>', '</sub>'],
  sup: ['<sup>', '</sup>'],
  code: ['<code>', '</code>'],
};

export function fb2ToIr(buf) {
  const ir = emptyIr();
  const xml = stripBom(buf.toString('utf8'));
  const parser = sax.parser(false, { lowercase: true, trim: false });

  const stack = [];
  let inDescription = false;
  let inTitleInfo = false;
  let inBinary = false;
  let binaryId = null;
  let binaryType = null;
  let binaryChunks = [];
  let coverHref = null;

  // author name assembly
  let inAuthor = false;
  let first = '';
  let last = '';
  let nick = '';
  let authorField = null;

  // body rendering
  let bodyDepth = 0; // >0 while inside a <body> we render
  let skipBody = false; // notes/comments bodies
  let sectionDepth = 0;
  let html = '';
  let chapters = [];
  let pendingTitle = '';
  let inTitle = false;
  let titleText = '';
  let textField = null; // 'book-title' | 'lang' | null (for description)

  const flushChapter = () => {
    const body = sanitizeHtml(html);
    if (body || pendingTitle) {
      chapters.push({ title: pendingTitle.trim(), html: body });
    }
    html = '';
    pendingTitle = '';
  };

  parser.onopentag = (node) => {
    const name = node.name;
    stack.push(name);

    if (name === 'description') inDescription = true;
    if (name === 'title-info') inTitleInfo = true;

    if (inDescription) {
      if (name === 'author') {
        inAuthor = true;
        first = last = nick = '';
      }
      if (inAuthor && ['first-name', 'last-name', 'nickname'].includes(name)) {
        authorField = name;
      }
      if (inTitleInfo && name === 'book-title') textField = 'book-title';
      if (inTitleInfo && name === 'lang') textField = 'lang';
      if (name === 'image' && stack.includes('coverpage')) {
        const href = node.attributes['l:href'] || node.attributes['xlink:href'] || '';
        if (href.startsWith('#')) coverHref = href.slice(1);
      }
      return;
    }

    if (name === 'binary') {
      inBinary = true;
      binaryId = node.attributes.id || '';
      binaryType = node.attributes['content-type'] || 'image/jpeg';
      binaryChunks = [];
      return;
    }

    if (name === 'body') {
      const cls = (node.attributes.name || '').toLowerCase();
      skipBody = cls === 'notes' || cls === 'comments';
      bodyDepth = 1;
      return;
    }

    if (bodyDepth === 0 || skipBody) return;

    switch (name) {
      case 'section':
        sectionDepth++;
        if (sectionDepth > 1) html += `<hr class="section"/>`;
        break;
      case 'title':
        inTitle = true;
        titleText = '';
        break;
      case 'image': {
        const href =
          node.attributes['l:href'] || node.attributes['xlink:href'] || '';
        const id = href.replace(/^#/, '');
        if (id) html += `<img src="images/${escapeXml(id)}" alt=""/>`;
        break;
      }
      default:
        if (INLINE[name]) html += INLINE[name][0];
        else if (BLOCK_OPEN[name] !== undefined && !inTitle) html += BLOCK_OPEN[name];
    }
  };

  parser.ontext = (t) => {
    if (inBinary) {
      binaryChunks.push(t);
      return;
    }
    if (inDescription) {
      if (authorField === 'first-name') first += t;
      else if (authorField === 'last-name') last += t;
      else if (authorField === 'nickname') nick += t;
      else if (textField === 'book-title') ir.title = (ir.title === 'Untitled' ? '' : ir.title) + t;
      else if (textField === 'lang') ir.language += t;
      return;
    }
    if (bodyDepth === 0 || skipBody) return;
    const esc = escapeXml(t);
    if (inTitle) titleText += t;
    else html += esc;
  };

  parser.onclosetag = (name) => {
    stack.pop();

    if (name === 'binary') {
      try {
        const data = Buffer.from(binaryChunks.join('').replace(/\s+/g, ''), 'base64');
        ir.images.push({ id: binaryId, mime: binaryType, data });
      } catch {
        /* skip bad binary */
      }
      inBinary = false;
      return;
    }

    if (inDescription) {
      if (name === 'author') {
        const full = [first.trim(), last.trim()].filter(Boolean).join(' ') || nick.trim();
        if (full && stack.includes('title-info')) ir.authors.push(full);
        inAuthor = false;
      }
      if (['first-name', 'last-name', 'nickname'].includes(name)) authorField = null;
      if (name === 'book-title' || name === 'lang') textField = null;
      if (name === 'title-info') inTitleInfo = false;
      if (name === 'description') inDescription = false;
      return;
    }

    if (bodyDepth === 0 || skipBody) {
      if (name === 'body') {
        bodyDepth = 0;
        skipBody = false;
      }
      return;
    }

    switch (name) {
      case 'body':
        flushChapter();
        bodyDepth = 0;
        sectionDepth = 0;
        break;
      case 'section':
        sectionDepth--;
        if (sectionDepth === 0) flushChapter();
        break;
      case 'title':
        inTitle = false;
        if (sectionDepth <= 1 && !pendingTitle) pendingTitle = titleText.trim();
        else html += `<h2>${escapeXml(titleText.trim())}</h2>`;
        break;
      default:
        if (INLINE[name]) html += INLINE[name][1];
        else if (BLOCK_CLOSE[name] !== undefined) html += BLOCK_CLOSE[name];
    }
  };

  try {
    parser.write(xml).close();
  } catch {
    /* be lenient */
  }

  if (!ir.title || ir.title === 'Untitled') ir.title = 'Untitled';
  ir.title = ir.title.trim() || 'Untitled';
  ir.language = ir.language.trim();
  ir.authors = ir.authors.map((a) => a.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (coverHref) {
    const img = ir.images.find((i) => i.id === coverHref);
    if (img) ir.cover = { mime: img.mime, data: img.data };
  }
  if (!ir.cover && ir.images[0]) ir.cover = { mime: ir.images[0].mime, data: ir.images[0].data };
  if (!chapters.length) chapters = [{ title: ir.title, html: '<p></p>' }];
  ir.chapters = chapters;
  return ir;
}

// ---------------------------------------------------------------------------
// IR -> FB2
// ---------------------------------------------------------------------------

export function irToFb2(ir) {
  const genreLang = ir.language || 'en';
  const authorsXml = (ir.authors.length ? ir.authors : ['Unknown'])
    .map((a) => {
      const parts = a.split(/\s+/);
      const lastName = parts.length > 1 ? parts.pop() : a;
      const firstName = parts.join(' ');
      return `<author><first-name>${escapeXml(firstName)}</first-name><last-name>${escapeXml(lastName)}</last-name></author>`;
    })
    .join('');

  const coverXml = ir.cover
    ? `<coverpage><image l:href="#cover${extForMime(ir.cover.mime)}"/></coverpage>`
    : '';

  const sections = ir.chapters
    .map((ch) => {
      const title = ch.title
        ? `<title><p>${escapeXml(ch.title)}</p></title>`
        : '';
      const body = htmlFragmentToFb2(ch.html);
      return `<section>${title}${body || '<empty-line/>'}</section>`;
    })
    .join('\n');

  const binaries = [];
  if (ir.cover) {
    binaries.push(
      `<binary id="cover${extForMime(ir.cover.mime)}" content-type="${ir.cover.mime}">${ir.cover.data.toString('base64')}</binary>`,
    );
  }
  for (const img of ir.images) {
    // Avoid duplicating the cover binary.
    if (ir.cover && img.data.equals(ir.cover.data)) continue;
    binaries.push(
      `<binary id="${escapeXml(img.id)}" content-type="${img.mime}">${img.data.toString('base64')}</binary>`,
    );
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
<title-info>
<genre>prose</genre>
${authorsXml}
<book-title>${escapeXml(ir.title)}</book-title>
<lang>${escapeXml(genreLang)}</lang>
${coverXml}
</title-info>
<document-info>
<author><nickname>sopds</nickname></author>
<program-used>sopds-convert</program-used>
<date>${new Date().toISOString().slice(0, 10)}</date>
<id>${escapeXml(ir.identifier)}</id>
<version>1.0</version>
</document-info>
</description>
<body>
${sections}
</body>
${binaries.join('\n')}
</FictionBook>`;
}

function htmlFragmentToFb2(html) {
  let s = sanitizeHtml(html);
  // inline
  s = s
    .replace(/<(em|i)>/gi, '<emphasis>')
    .replace(/<\/(em|i)>/gi, '</emphasis>')
    .replace(/<(strong|b)>/gi, '<strong>')
    .replace(/<\/(strong|b)>/gi, '</strong>');
  // images
  s = s.replace(/<img[^>]*src=["']images\/([^"']+)["'][^>]*>/gi, '<image l:href="#$1"/>');
  s = s.replace(/<img[^>]*>/gi, '');
  // headings -> subtitle
  s = s.replace(/<h[1-6][^>]*>/gi, '<subtitle>').replace(/<\/h[1-6]>/gi, '</subtitle>');
  // block level
  s = s
    .replace(/<br\s*\/?>/gi, '<empty-line/>')
    .replace(/<hr[^>]*>/gi, '<empty-line/>')
    .replace(/<blockquote[^>]*>/gi, '<cite>')
    .replace(/<\/blockquote>/gi, '</cite>')
    .replace(/<div[^>]*>/gi, '<p>')
    .replace(/<\/div>/gi, '</p>');
  // Anything still lacking <p> wrappers: fall back to paragraph splitting.
  if (!/<p>/i.test(s)) {
    return htmlToParagraphs(html)
      .map((p) => `<p>${escapeXml(p)}</p>`)
      .join('');
  }
  // Drop leftover unknown tags but keep fb2-valid ones.
  s = s.replace(/<(?!\/?(p|emphasis|strong|s|sub|sup|code|empty-line|image|subtitle|cite|epigraph|poem|stanza|v|text-author)\b)[^>]*>/gi, '');
  return s;
}

function extForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
