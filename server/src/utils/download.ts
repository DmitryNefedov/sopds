import AdmZip from 'adm-zip';

// Shaping a book file into an HTTP download: its media type, its filename and
// the optional one-file `.zip` wrapper some readers prefer.

const MIME: Record<string, string> = {
  fb2: 'application/fb2+xml',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  pdf: 'application/pdf',
  djvu: 'image/vnd.djvu',
  zip: 'application/zip',
};

export function mimeFor(fmt: string): string {
  return MIME[fmt] || 'application/octet-stream';
}

/** Wrap a single book in a `.zip`. Small and in-memory, so `adm-zip` is fine
 *  here — the streaming reader in `connectors/zip.ts` is for the collection. */
export function zipWrap(buf: Buffer, name: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(name, buf);
  return zip.toBuffer();
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', з: 'z', и: 'i',
  й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ы: 'y', э: 'e', ж: 'zh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'sch', ю: 'ju', я: 'ja', ъ: '', ь: '',
};

/** Turn a (often Russian) book title into an ASCII-safe download filename. */
export function translitName(s: string): string {
  let out = '';
  for (const ch of (s || '').toLowerCase()) {
    if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (/[a-z0-9._-]/i.test(ch)) out += ch;
    else if (ch === ' ') out += '_';
  }
  return out.replace(/_+/g, '_').replace(/^_|_$/g, '') || 'book';
}
