// Intermediate representation shared by every converter.

export interface IrImage {
  id: string;
  mime: string;
  data: Buffer;
}

export interface IrChapter {
  title: string;
  html: string;
}

export interface Ir {
  title: string;
  language: string;
  identifier: string;
  authors: string[];
  cover: { mime: string; data: Buffer } | null;
  chapters: IrChapter[];
  /** id is referenced as "images/<id>" */
  images: IrImage[];
}

export function emptyIr(): Ir {
  return {
    title: 'Untitled',
    language: '',
    identifier: `sopds-${Date.now()}`,
    authors: [],
    cover: null,
    chapters: [],
    images: [],
  };
}

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  // '.jpeg' maps to the same value the `|| 'image/jpeg'` fallback returns, so
  // blanking the key is unobservable.
  // Stryker disable next-line StringLiteral: equivalent, see above
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

export function mimeFromName(name: string): string {
  const m = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return (m && EXT_MIME[m[0]]) || 'image/jpeg';
}

export function extFromMime(mime: string): string {
  for (const [ext, m] of Object.entries(EXT_MIME)) if (m === mime) return ext;
  return '.jpg';
}

export function escapeXml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Strip anything we do not want to carry between formats: scripts, styles,
// event handlers, and (optionally) unresolved external links.
export function sanitizeHtml(html: string | null | undefined): string {
  return String(html || '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/ on[a-z]+\s*=\s*'[^']*'/gi, '')
    .trim();
}

// Elements that never take a closing tag; anything else we open we must close.
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

// The named entities worth keeping when moving HTML into XHTML, which declares
// none of them. Everything else becomes a literal '&'.
// The five entities XHTML itself declares; kept verbatim, everything else is
// rewritten or escaped.
const XML_ENTITIES = new Set(['amp;', 'lt;', 'gt;', 'quot;', 'apos;']);

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: '#160', copy: '#169', reg: '#174', deg: '#176', middot: '#183',
  ndash: '#8211', mdash: '#8212', lsquo: '#8216', rsquo: '#8217',
  ldquo: '#8220', rdquo: '#8221', bull: '#8226', hellip: '#8230',
  laquo: '#171', raquo: '#187', trade: '#8482', euro: '#8364',
  pound: '#163', sect: '#167', para: '#182', times: '#215', divide: '#247',
};

/**
 * Make a chapter fragment safe to drop into XHTML: drop stray closing tags,
 * close open ones, self-close void elements and escape bare '&'. EPUB readers
 * parse each chapter as strict XML, where one bad byte silently blanks the
 * whole file rather than the one paragraph.
 */
export function balanceHtml(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  const tag = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = tag.exec(html))) {
    out.push(fixEntities(html.slice(last, m.index)));
    last = tag.lastIndex;
    const name = m[1].toLowerCase();
    const self = fixEntities(m[0]); // '&' can hide in an href too
    if (m[0].startsWith('</')) {
      const at = open.lastIndexOf(name);
      if (at === -1) continue; // a closer that never opened: drop it
      // Close anything opened inside it and left open.
      for (let i = open.length - 1; i > at; i--) out.push(`</${open[i]}>`);
      open.length = at;
      out.push(`</${name}>`);
    } else if (VOID_TAGS.has(name)) {
      // the `tag` regex guarantees `self` ends with exactly one '>', so
      // anchoring the replace is not observable.
      // Stryker disable next-line Regex: equivalent, see above
      out.push(m[2] === '/' ? self : self.replace(/>$/, '/>'));
    } else {
      out.push(self);
      if (m[2] !== '/') open.push(name);
    }
  }
  out.push(fixEntities(html.slice(last)));
  for (let i = open.length - 1; i >= 0; i--) out.push(`</${open[i]}>`);
  return out.join('');
}

function fixEntities(s: string): string {
  return s.replace(
    /&(#\d+;|#x[0-9a-fA-F]+;|amp;|lt;|gt;|quot;|apos;|[a-zA-Z][a-zA-Z0-9]*;)?/g,
    (whole, ref?: string) => {
      if (!ref) return '&amp;'; // a bare '&'
      if (ref.startsWith('#') || XML_ENTITIES.has(ref)) return whole;
      const numeric = NAMED_ENTITIES[ref.slice(0, -1)];
      // XHTML declares no named entities beyond the five XML ones.
      return numeric ? `&${numeric};` : `&amp;${ref}`;
    },
  );
}

// Very small HTML -> plain-text-ish paragraph splitter, used when a target
// format (FB2) wants structured <p> content.
export function htmlToParagraphs(html: string | null | undefined): string[] {
  const withBreaks = String(html || '')
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  return withBreaks
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
