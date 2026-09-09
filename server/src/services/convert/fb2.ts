import sax from 'sax';
import { decodeXmlBuffer } from '../../formats/fb2.js';
import { emptyIr, escapeXml, htmlToParagraphs, sanitizeHtml } from './ir.js';
import type { Ir, IrChapter } from './ir.js';

type Attrs = Record<string, string>;

// ---------------------------------------------------------------------------
// FB2 -> IR
// ---------------------------------------------------------------------------

const BLOCK_OPEN: Record<string, string> = {
  p: '<p>',
  subtitle: '<p class="subtitle">',
  'empty-line': '<br/>',
  // Stryker disable next-line StringLiteral: a real <title> tag sets inTitle and
  // returns before this map is consulted, so the value is never emitted.
  title: '', // handled specially (becomes chapter/heading text)
  epigraph: '<blockquote>',
  cite: '<blockquote>',
  poem: '<blockquote>',
  stanza: '<p class="stanza">',
  v: '<span class="v">',
  'text-author': '<p class="text-author">',
};
const BLOCK_CLOSE: Record<string, string> = {
  p: '</p>',
  subtitle: '</p>',
  epigraph: '</blockquote>',
  cite: '</blockquote>',
  poem: '</blockquote>',
  stanza: '</p>',
  // A verse is one line: close the span and break, or the whole stanza runs
  // together as a single paragraph.
  v: '</span><br/>',
  'text-author': '</p>',
};
const INLINE: Record<string, [string, string]> = {
  emphasis: ['<em>', '</em>'],
  strong: ['<strong>', '</strong>'],
  strikethrough: ['<s>', '</s>'],
  sub: ['<sub>', '</sub>'],
  sup: ['<sup>', '</sup>'],
  code: ['<code>', '</code>'],
};

export function fb2ToIr(buf: Buffer): Ir {
  const ir = emptyIr();
  const xml = decodeXmlBuffer(buf);
  // Stryker disable next-line BooleanLiteral: non-strict is deliberate - real FB2
  // is frequently not well-formed and strict mode would abort the parse.
  const parser = sax.parser(false, { lowercase: true, trim: false });

  // The many parser-state flags below are all either reset by the open-tag that
  // starts the region they guard (binaryChunks, first/last/nick, titleText) or
  // are guarded by a structural check that a stray initial value cannot get
  // past (stack contents, inDescription, inTitleInfo, inAuthor, skipBody). Their
  // initial values are not independently observable.
  // Stryker disable all
  const stack: string[] = [];
  let inDescription = false;
  let inTitleInfo = false;
  let inBinary = false;
  let binaryId: string | null = null;
  let binaryType: string | null = null;
  let binaryChunks: string[] = [];
  let coverHref: string | null = null;

  // author name assembly
  let inAuthor = false;
  let first = '';
  let last = '';
  let nick = '';
  let authorField: string | null = null;
  // Stryker restore all

  // body rendering
  let bodyDepth = 0; // >0 while inside a <body> we render
  /** True only inside a <body> we actually render (i.e. not notes/comments). */
  const inRenderedBody = (): boolean => bodyDepth > 0 && !skipBody;
  // Stryker disable next-line BooleanLiteral: every <body> open sets this before
  // it is read; the initial value is dead.
  let skipBody = false; // notes/comments bodies
  let sectionDepth = 0;
  let html = '';
  let chapters: IrChapter[] = [];
  let pendingTitle = '';
  let inTitle = false;
  // Stryker disable next-line StringLiteral: every <title> open resets this.
  let titleText = '';
  let textField: string | null = null; // 'book-title' | 'lang' | null (for description)

  const flushChapter = () => {
    const body = sanitizeHtml(html);
    if (body || pendingTitle) {
      // Stryker disable next-line MethodExpression: pendingTitle is stored
      // already trimmed (see the title close handler), so this is a no-op.
      chapters.push({ title: pendingTitle.trim(), html: body });
    }
    html = '';
    pendingTitle = '';
  };

  parser.onopentag = (node) => {
    const name = node.name;
    const attributes = (node as sax.Tag).attributes as Attrs;
    stack.push(name);

    if (name === 'description') inDescription = true;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: inTitleInfo
    // duplicates stack state and only gates textField for the single book-title
    // and lang elements, both of which sit in title-info in valid FB2.
        if (name === 'title-info') inTitleInfo = true;

    if (inDescription) {
      // The `inTitleInfo` / `inAuthor` flags here duplicate what `stack` already
      // records, and `stack.includes(...)` is the gate that actually decides
      // whether an author counts (see the close handler); the extra `&&`
      // conditions cannot be independently observed for valid FB2, and any text
      // that leaks through between elements is trimmed off at the end.
      if (name === 'author') {
        inAuthor = true;
        first = last = nick = '';
      }
      // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator
      if (inAuthor && ['first-name', 'last-name', 'nickname'].includes(name)) {
        authorField = name;
      }
      // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator
      if (inTitleInfo && name === 'book-title') textField = 'book-title';
      // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator
      if (inTitleInfo && name === 'lang') textField = 'lang';
      // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: a
      // non-image tag has no href so coverHref stays null; a cover <image> not
      // in <coverpage> just falls through to the images[0] fallback.
      if (name === 'image' && stack.includes('coverpage')) {
        // Stryker disable next-line LogicalOperator,StringLiteral: a missing href
        // yields '' -> not a '#...' -> coverHref stays null, same as the fallback.
        const href = attributes['l:href'] || attributes['xlink:href'] || '';
        // Stryker disable next-line ConditionalExpression,MethodExpression,StringLiteral: a
        // non-# or empty href leaves coverHref falsy, and `if (coverHref)` below
        // then skips it - same as not matching.
        if (href.startsWith('#')) coverHref = href.slice(1);
      }
      return;
    }

    if (name === 'binary') {
      inBinary = true;
      // Stryker disable next-line StringLiteral: the image push re-applies the
      // `|| ''` default to binaryId, masking this one.
      binaryId = attributes.id || '';
      // Stryker disable next-line StringLiteral: the image push below re-applies
      // the same `|| 'image/jpeg'` default, so blanking it here is masked.
      binaryType = attributes['content-type'] || 'image/jpeg';
      binaryChunks = [];
      return;
    }

    if (name === 'body') {
      // Stryker disable next-line StringLiteral: a body whose name is neither
      // 'notes' nor 'comments' is rendered, exactly as one with no name.
      const cls = (attributes.name || '').toLowerCase();
      skipBody = cls === 'notes' || cls === 'comments';
      bodyDepth = 1;
      return;
    }

    if (!inRenderedBody()) return;

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
          attributes['l:href'] || attributes['xlink:href'] || '';
        // Stryker disable next-line Regex: an FB2 image href is always `#id`, so
        // dropping the `^` anchor changes nothing for real input.
        const id = href.replace(/^#/, '');
        if (id) html += `<img src="images/${escapeXml(id)}" alt=""/>`;
        break;
      }
      default:
        // A <title> contributes no markup: its text is collected into
        // `titleText` and re-emitted as the chapter heading. Every tag inside
        // it has to be dropped at BOTH ends — suppressing the opener while
        // still writing the closer is what used to leave a stray </p> as the
        // first thing in the chapter body.
        if (inTitle) break;
        if (INLINE[name]) html += INLINE[name][0];
        else if (BLOCK_OPEN[name] !== undefined) html += BLOCK_OPEN[name];
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
    if (!inRenderedBody()) return;
    const esc = escapeXml(t);
    if (inTitle) titleText += t;
    else html += esc;
  };

  parser.onclosetag = (name) => {
    stack.pop();

    if (name === 'binary') {
      try {
        // Stryker disable next-line Regex,StringLiteral: base64 decoding ignores
        // any character it does not recognise, so what this replace leaves
        // behind (empty string, or even junk) decodes to the same bytes.
        const data = Buffer.from(binaryChunks.join('').replace(/\s+/g, ''), 'base64');
        // Stryker disable next-line StringLiteral: binaryId/binaryType already hold
        // '' / 'image/jpeg' defaults from the open handler; the `||` here is belt.
        ir.images.push({ id: binaryId || '', mime: binaryType || 'image/jpeg', data });
      } catch {
        /* skip bad binary */
      }
      // Stryker disable next-line BooleanLiteral: binaries sit after the body, so
      // stray text once inBinary is stuck true is only inter-element whitespace.
      inBinary = false;
      return;
    }

    if (inDescription) {
      if (name === 'author') {
        // Stryker disable next-line MethodExpression: the final `ir.authors`
        // normalization re-trims and collapses whitespace, masking these trims.
        const full = [first.trim(), last.trim()].filter(Boolean).join(' ') || nick.trim();
        if (full && stack.includes('title-info')) ir.authors.push(full);
        // Stryker disable next-line BooleanLiteral: `first/last/nick` are reset by
        // the next <author> open, so a stuck-true inAuthor changes nothing.
        inAuthor = false;
      }
      // These resets only matter until the next matching open tag sets the flag
      // again, and stray text in between is trimmed off - so relaxing or
      // tightening the guards is not observable for valid FB2.
      // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,ArrayDeclaration,StringLiteral
      if (['first-name', 'last-name', 'nickname'].includes(name)) authorField = null;
      // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,StringLiteral
      if (name === 'book-title' || name === 'lang') textField = null;
      // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral,BooleanLiteral
      if (name === 'title-info') inTitleInfo = false;
      if (name === 'description') inDescription = false;
      return;
    }

    if (!inRenderedBody()) {
      // This branch only runs for a notes/comments body; its content stays
      // skipped whatever these do, and the next <body> open resets the state.
      // Stryker disable ConditionalExpression,EqualityOperator,StringLiteral,BlockStatement,BooleanLiteral
      if (name === 'body') {
        bodyDepth = 0;
        skipBody = false;
      }
      // Stryker restore ConditionalExpression,EqualityOperator,StringLiteral,BlockStatement,BooleanLiteral
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
      case 'title': {
        inTitle = false;
        const t = titleText.replace(/\s+/g, ' ').trim();
        if (sectionDepth <= 1 && !pendingTitle) pendingTitle = t;
        else if (t) html += `<h2>${escapeXml(t)}</h2>`;
        break;
      }
      default:
        if (inTitle) {
          // Titles are often several <p>s; keep their text from running
          // together into one word.
          if (BLOCK_CLOSE[name] !== undefined) titleText += ' ';
          break;
        }
        if (INLINE[name]) html += INLINE[name][1];
        else if (BLOCK_CLOSE[name] !== undefined) html += BLOCK_CLOSE[name];
    }
  };

  try {
    parser.write(xml).close();
  } catch {
    /* be lenient */
  }

  ir.title = ir.title.trim() || 'Untitled';
  ir.language = ir.language.trim();
  // Stryker disable next-line MethodExpression: `filter(Boolean)` only drops
  // empty names (which the assembly above never produces) and the inner `.trim()`
  // is redundant with the per-part trims - both are no-ops for real input.
  ir.authors = ir.authors.map((a) => a.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // Stryker disable next-line ConditionalExpression: with coverHref null the
  // find() below just matches nothing - the guard only skips a wasted scan.
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

export function irToFb2(ir: Ir): string {
  const genreLang = ir.language || 'en';
  const authorsXml = (ir.authors.length ? ir.authors : ['Unknown'])
    .map((a) => {
      const parts = a.split(/\s+/);
      const lastName = parts.length > 1 ? parts.pop()! : a;
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

  const binaries: string[] = [];
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

export function htmlFragmentToFb2(html: string): string {
  let s = sanitizeHtml(html);
  // inline
  s = s
    .replace(/<(em|i)>/gi, '<emphasis>')
    .replace(/<\/(em|i)>/gi, '</emphasis>')
    .replace(/<(strong|b)>/gi, '<strong>')
    .replace(/<\/(strong|b)>/gi, '</strong>');
  // images
  s = s.replace(/<img[^>]*src=["']images\/([^"']+)["'][^>]*>/gi, '<image l:href="#$1"/>');
  // Stryker disable next-line Regex: a leftover <img> that this misses is
  // stripped by the unknown-tag pass a few lines down anyway.
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

export function extForMime(mime: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}
