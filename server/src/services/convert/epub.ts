import AdmZip from 'adm-zip';
import sax from 'sax';
import { ZipWriter } from './zipwriter.js';
import { balanceHtml, emptyIr, escapeXml, extFromMime, mimeFromName, sanitizeHtml } from './ir.js';
import type { Ir, IrImage } from './ir.js';

type Attrs = Record<string, string>;
interface ManifestEntry {
  href: string;
  type: string;
  props: string;
}

// ---------------------------------------------------------------------------
// EPUB -> IR
// ---------------------------------------------------------------------------

export function epubToIr(buf: Buffer): Ir {
  const ir = emptyIr();
  const zip = new AdmZip(buf);
  const read = (name: string): Buffer | null => {
    const e = zip.getEntry(name);
    return e ? e.getData() : null;
  };

  // locate OPF
  let opfPath = 'OEBPS/content.opf';
  const container = read('META-INF/container.xml');
  if (container) {
    const m = container.toString('utf8').match(/full-path="([^"]+)"/i);
    if (m) opfPath = m[1];
  }
  const opfBuf = read(opfPath);
  if (!opfBuf) throw new Error('EPUB: content.opf not found');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const resolve = (href: string) => normalizePath(opfDir + decodeURIComponent(href));

  const manifest: Record<string, ManifestEntry> = {};
  const spine: string[] = [];
  let coverId: string | null = null;
  const dc: Record<string, string[]> = {
    title: [],
    creator: [],
    language: [],
    identifier: [],
    description: [],
  };

  const parser = sax.parser(false, { lowercase: true, trim: true });
  let cur: string | null = null;
  parser.onopentag = (node) => {
    const n = node.name;
    const a = (node as sax.Tag).attributes as Attrs;
    if (n === 'item') {
      manifest[a.id] = {
        href: a.href,
        type: a['media-type'] || '',
        props: a.properties || '',
      };
      if ((a.properties || '').includes('cover-image')) coverId = a.id;
    } else if (n === 'itemref') {
      spine.push(a.idref);
    } else if (n === 'meta' && a.name === 'cover') {
      coverId = a.content;
    } else if (n.startsWith('dc:')) {
      cur = n.slice(3);
    }
  };
  parser.ontext = (t) => {
    if (cur && dc[cur] && t) dc[cur].push(t);
  };
  parser.onclosetag = () => {
    cur = null;
  };
  parser.write(opfBuf.toString('utf8')).close();

  ir.title = dc.title[0] || 'Untitled';
  ir.language = dc.language[0] || '';
  ir.identifier = dc.identifier[0] || ir.identifier;
  ir.authors = dc.creator.slice();

  // images
  for (const item of Object.values(manifest)) {
    if (!item.type.startsWith('image/')) continue;
    const data = read(resolve(item.href));
    if (!data) continue;
    const imgId = basename(item.href);
    ir.images.push({ id: imgId, mime: item.type || mimeFromName(item.href), data });
  }
  if (coverId && manifest[coverId]) {
    const item = manifest[coverId];
    const data = read(resolve(item.href));
    if (data) ir.cover = { mime: item.type || mimeFromName(item.href), data };
  }

  // chapters from spine
  for (const idref of spine) {
    const item = manifest[idref];
    if (!item) continue;
    if (!/x?html/.test(item.type) && !/\.x?html?$/.test(item.href)) continue;
    const raw = read(resolve(item.href));
    if (!raw) continue;
    const { title, html } = extractChapter(raw.toString('utf8'), item.href, ir);
    if (html.trim()) ir.chapters.push({ title, html });
  }

  if (!ir.chapters.length) ir.chapters = [{ title: ir.title, html: '<p></p>' }];
  if (!ir.cover && ir.images[0]) ir.cover = { mime: ir.images[0].mime, data: ir.images[0].data };
  return ir;
}

function extractChapter(xhtml: string, _href: string, _ir: Ir): { title: string; html: string } {
  const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : xhtml;
  const h = body.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  const title = h ? h[1].replace(/<[^>]+>/g, '').trim() : '';

  // rewrite <img src> to images/<basename>
  body = body.replace(/(<img\b[^>]*\bsrc=)(["'])([^"']+)\2/gi, (m, p, q, src) => {
    return `${p}${q}images/${basename(src)}${q}`;
  });
  // drop stylesheet links, keep structure
  body = sanitizeHtml(body).replace(/<link\b[^>]*>/gi, '');
  return { title, html: body };
}

// ---------------------------------------------------------------------------
// IR -> EPUB
// ---------------------------------------------------------------------------

const CSS = `body{font-family:serif;line-height:1.5;margin:1em}h1,h2,h3{font-family:sans-serif}
p{margin:0 0 .6em;text-indent:1.2em}p.subtitle{font-weight:bold;text-indent:0}
img{max-width:100%;height:auto}blockquote{margin:1em 2em;font-style:italic}
hr.section{border:0;border-top:1px solid #999;margin:1.5em 20%}`;

interface ImageEntry {
  id: string;
  file: string;
  mime: string;
  data: Buffer;
}

export function irToEpub(ir: Ir): Buffer {
  const zip = new ZipWriter();
  // The OCF spec requires `mimetype` to be the first entry and STORED.
  zip.add('mimetype', 'application/epub+zip', { store: true });

  zip.add(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );

  zip.add('OEBPS/style.css', CSS);

  // images
  const imageEntries: ImageEntry[] = [];
  const seen = new Set<string>();
  const pushImage = (img: { id: string; mime: string; data: Buffer }, forcedId?: string): string => {
    const id = forcedId || sanitizeId(img.id);
    const ext = extFromName(img.id) || extFromMime(img.mime);
    const file = `images/${id}${ext.startsWith('.') ? ext : '.' + ext}`;
    if (seen.has(file)) return imageEntries.find((e) => e.data.equals(img.data))?.file || file;
    seen.add(file);
    zip.add(`OEBPS/${file}`, img.data);
    imageEntries.push({ id: `img-${imageEntries.length}`, file, mime: img.mime, data: img.data });
    return file;
  };

  let coverFile: string | null = null;
  if (ir.cover) coverFile = pushImage({ id: 'cover', mime: ir.cover.mime, data: ir.cover.data }, 'cover');
  for (const img of ir.images) {
    if (ir.cover && img.data.equals(ir.cover.data)) continue;
    pushImage(img);
  }

  // chapters
  const chapterFiles = ir.chapters.map((ch, i) => {
    const file = `text/chapter-${String(i + 1).padStart(4, '0')}.xhtml`;
    const heading = ch.title ? `<h2>${escapeXml(ch.title)}</h2>\n` : '';
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8"/><title>${escapeXml(ch.title || ir.title)}</title>
<link rel="stylesheet" type="text/css" href="../style.css"/>
</head><body>
${heading}${balanceHtml(fixImgPaths(ch.html))}
</body></html>`;
    zip.add(`OEBPS/${file}`, xhtml);
    return { id: `chap-${i + 1}`, file, title: ch.title || `Chapter ${i + 1}` };
  });

  // cover page
  let coverPage: { id: string; file: string } | null = null;
  if (coverFile) {
    coverPage = { id: 'cover-page', file: 'text/cover.xhtml' };
    zip.add(
      `OEBPS/${coverPage.file}`,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>Cover</title></head>
<body style="margin:0;text-align:center"><img src="../${coverFile}" alt="cover" style="max-width:100%;height:100vh"/></body></html>`,
    );
  }

  const manifestItems = [
    '<item id="css" href="style.css" media-type="text/css"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    ...(coverPage
      ? [`<item id="${coverPage.id}" href="${coverPage.file}" media-type="application/xhtml+xml"/>`]
      : []),
    ...chapterFiles.map(
      (c) => `<item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"/>`,
    ),
    ...imageEntries.map((im) => {
      const isCover = im.file === coverFile;
      return `<item id="${isCover ? 'cover-image' : im.id}" href="${im.file}" media-type="${im.mime}"${isCover ? ' properties="cover-image"' : ''}/>`;
    }),
  ].join('\n    ');

  const spine = [
    ...(coverPage ? [`<itemref idref="${coverPage.id}"/>`] : []),
    ...chapterFiles.map((c) => `<itemref idref="${c.id}"/>`),
  ].join('\n    ');

  const authorsXml = (ir.authors.length ? ir.authors : ['Unknown'])
    .map((a, i) => `<dc:creator id="creator-${i}">${escapeXml(a)}</dc:creator>`)
    .join('\n    ');

  zip.add(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(ir.identifier)}</dc:identifier>
    <dc:title>${escapeXml(ir.title)}</dc:title>
    <dc:language>${escapeXml(ir.language || 'en')}</dc:language>
    ${authorsXml}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
    ${coverFile ? '<meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spine}
  </spine>
</package>`,
  );

  const navPoints = chapterFiles
    .map(
      (c, i) => `<navPoint id="np-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(c.title)}</text></navLabel>
      <content src="${c.file}"/>
    </navPoint>`,
    )
    .join('\n    ');

  zip.add(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${escapeXml(ir.identifier)}"/></head>
  <docTitle><text>${escapeXml(ir.title)}</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`,
  );

  return zip.toBuffer();
}

// helpers -------------------------------------------------------------------

function fixImgPaths(html: string): string {
  return String(html || '').replace(
    /(<img\b[^>]*\bsrc=)(["'])images\/([^"']+)\2/gi,
    (_m, p, q, name) => `${p}${q}../images/${name}${q}`,
  );
}

function basename(p: string): string {
  const parts = String(p).split('/').pop() || '';
  return parts.split('\\').pop() || '';
}
function extFromName(name: string): string {
  const m = String(name).toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : '';
}
function sanitizeId(s: string): string {
  return String(s || 'img').replace(/[^a-z0-9._-]/gi, '_').replace(/\.[^.]+$/, '') || 'img';
}
function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
