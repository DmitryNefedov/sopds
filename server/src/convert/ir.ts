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
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}
