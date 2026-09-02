// Intermediate representation shared by every converter.
//
//   {
//     title, language, identifier,
//     authors: [string],
//     cover: { mime, data: Buffer } | null,
//     chapters: [{ title, html }],   // html is a sanitised body fragment
//     images:   [{ id, mime, data: Buffer }],  // id is referenced as "images/<id>"
//   }

export function emptyIr() {
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

const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

export function mimeFromName(name) {
  const m = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return (m && EXT_MIME[m[0]]) || 'image/jpeg';
}

export function extFromMime(mime) {
  for (const [ext, m] of Object.entries(EXT_MIME)) if (m === mime) return ext;
  return '.jpg';
}

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Strip anything we do not want to carry between formats: scripts, styles,
// event handlers, and (optionally) unresolved external links.
export function sanitizeHtml(html) {
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
export function htmlToParagraphs(html) {
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
