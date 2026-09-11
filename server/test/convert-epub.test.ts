import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import {
  epubToIr,
  irToEpub,
  extractChapter,
  fixImgPaths,
  basename,
  extFromName,
  sanitizeId,
  normalizePath,
} from '../src/services/convert/epub.js';
import { emptyIr } from '../src/services/convert/ir.js';
import type { Ir } from '../src/services/convert/ir.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);

// Build an EPUB zip from parts, defaulting the boilerplate.
function makeEpub(opts: {
  opfPath?: string;
  container?: string;
  opf?: string;
  files?: Record<string, Buffer | string>;
}): Buffer {
  const opfPath = opts.opfPath ?? 'OEBPS/content.opf';
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      opts.container ??
        `<?xml version="1.0"?><container><rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
  );
  if (opts.opf !== undefined) zip.addFile(opfPath, Buffer.from(opts.opf));
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
}

const OPF = (body: string) => `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${body}</metadata>
  <manifest>${''}</manifest>
</package>`;

// ---- pure helpers ---------------------------------------------------

test('basename strips both / and \\ path separators', () => {
  assert.equal(basename('a/b/c.jpg'), 'c.jpg');
  assert.equal(basename('a\\b\\c.jpg'), 'c.jpg');
  assert.equal(basename('a/b\\c.jpg'), 'c.jpg');
  assert.equal(basename('plain.jpg'), 'plain.jpg');
  assert.equal(basename(''), '');
});

test('extFromName returns the lowercased final extension or empty', () => {
  assert.equal(extFromName('Photo.JPG'), '.jpg');
  assert.equal(extFromName('a.b.png'), '.png');
  assert.equal(extFromName('noext'), '');
  assert.equal(extFromName('trailing.'), '');
});

test('sanitizeId keeps id-safe characters, drops the extension, falls back to "img"', () => {
  assert.equal(sanitizeId('cover image!.jpg'), 'cover_image_');
  assert.equal(sanitizeId('a.b.c.png'), 'a.b.c');
  assert.equal(sanitizeId(''), 'img', 'empty falls back');
  assert.equal(sanitizeId('.hidden'), 'img', 'only an extension -> empty -> fallback');
});

test('normalizePath resolves . and .. segments', () => {
  assert.equal(normalizePath('OEBPS/text/../images/a.png'), 'OEBPS/images/a.png');
  assert.equal(normalizePath('./a/./b'), 'a/b');
  assert.equal(normalizePath('a//b'), 'a/b');
  assert.equal(normalizePath('a/b/../../c'), 'c');
});

test('fixImgPaths rewrites images/ src to ../images/ only', () => {
  assert.equal(
    fixImgPaths('<p><img src="images/pic.jpg"/> and <img src="http://x/y.png"/></p>'),
    '<p><img src="../images/pic.jpg"/> and <img src="http://x/y.png"/></p>',
  );
  assert.equal(
    fixImgPaths('<img class="c" src="images/deep.gif" width="9"/>'),
    '<img class="c" src="../images/deep.gif" width="9"/>',
    'attributes before and after src are preserved',
  );
  assert.equal(fixImgPaths(''), '');
  assert.equal(fixImgPaths(null as unknown as string), '');
});

// ---- extractChapter -----------------------------------------------

test('extractChapter takes the <body>, the first heading as title, rewrites img src, drops <link>', () => {
  const { title, html } = extractChapter(
    `<html><head><link rel="stylesheet" href="s.css"/></head><body class="c"><h1>The <em>Heading</em></h1><p>text</p><img src="pix/a.jpg"/></body></html>`,
    'text/ch.xhtml',
    emptyIr(),
  );
  assert.equal(title, 'The Heading', 'heading text, tags stripped');
  assert.equal(
    html,
    '<h1>The <em>Heading</em></h1><p>text</p><img src="images/a.jpg"/>',
    'body only, link gone, img src reduced to images/<basename> keeping other attrs order',
  );
});

test('extractChapter rewrites a deep img src and keeps trailing attributes', () => {
  const { html } = extractChapter('<p>frag <img src="deep/path/b.png" alt="x"/></p>', 'x.xhtml', emptyIr());
  assert.equal(html, '<p>frag <img src="images/b.png" alt="x"/></p>');
});

test('extractChapter reads the title from any of h1..h6, tags stripped and trimmed', () => {
  assert.equal(extractChapter('<body><h3 class="t">Only h3</h3><p>p</p></body>', 'x', emptyIr()).title, 'Only h3');
  assert.equal(extractChapter('<body><h6>Deep</h6></body>', 'x', emptyIr()).title, 'Deep');
  assert.equal(
    extractChapter('<body><h2>  <span class="s">Trimmed</span> Word  </h2></body>', 'x', emptyIr()).title,
    'Trimmed Word',
    'inner markup removed and surrounding whitespace trimmed',
  );
});

test('extractChapter rewrites an img src even when the tag carries attributes before src', () => {
  const { html } = extractChapter(
    '<body><img class="pic" data-k="v" src="a/b/pic.png" alt="cap"/></body>',
    'x',
    emptyIr(),
  );
  assert.equal(html, '<img class="pic" data-k="v" src="images/pic.png" alt="cap"/>');
});

test('extractChapter with no <body> uses the whole document, and no heading gives an empty title', () => {
  const { title, html } = extractChapter('<p>just a fragment</p>', 'x.xhtml', emptyIr());
  assert.equal(title, '');
  assert.equal(html, '<p>just a fragment</p>');
});

// ---- epubToIr ----------------------------------------------------

test('epubToIr reads the OPF from the path container.xml points at', () => {
  const epub = makeEpub({
    opfPath: 'book/pkg.opf',
    opf: OPF('<dc:title>Deep Book</dc:title>').replace(
      '<manifest></manifest>',
      `<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
       <spine><itemref idref="c1"/></spine>`,
    ),
    files: { 'book/ch1.xhtml': '<body><p>hi</p></body>' },
  });
  const ir = epubToIr(epub);
  assert.equal(ir.title, 'Deep Book');
  assert.deepEqual(ir.chapters.map((c) => c.html.trim()), ['<p>hi</p>']);
});

test('epubToIr throws when the OPF is missing', () => {
  assert.throws(() => epubToIr(makeEpub({})), /content\.opf not found/);
});

test('epubToIr uses the default OPF path when there is no container.xml (or no full-path in it)', () => {
  const opf = OPF('<dc:title>Defaulted</dc:title>').replace('<manifest></manifest>', '<manifest></manifest><spine></spine>');
  // container.xml omitted entirely
  const noContainer = new AdmZip();
  noContainer.addFile('mimetype', Buffer.from('application/epub+zip'));
  noContainer.addFile('OEBPS/content.opf', Buffer.from(opf));
  assert.equal(epubToIr(noContainer.toBuffer()).title, 'Defaulted');

  // container.xml present but without a full-path attribute
  const emptyContainer = makeEpub({ container: '<container><rootfiles/></container>', opf });
  assert.equal(epubToIr(emptyContainer).title, 'Defaulted');
});

test('epubToIr handles an OPF sitting at the archive root (no directory prefix)', () => {
  const epub = makeEpub({
    opfPath: 'book.opf',
    opf: OPF('<dc:title>Rooted</dc:title>').replace(
      '<manifest></manifest>',
      `<manifest><item id="c" href="ch.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine>`,
    ),
    files: { 'ch.xhtml': '<body><p>flat</p></body>' },
  });
  const ir = epubToIr(epub);
  assert.equal(ir.title, 'Rooted');
  assert.match(ir.chapters[0].html, /flat/, 'the chapter href resolves relative to the root');
});

test('epubToIr collects the Dublin Core metadata', () => {
  const epub = makeEpub({
    opf: OPF(
      `<dc:title>T</dc:title><dc:language>de</dc:language>
       <dc:identifier>urn:isbn:123</dc:identifier>
       <dc:creator>Ann Writer</dc:creator><dc:creator>Bob Author</dc:creator>`,
    ).replace('<manifest></manifest>', '<manifest></manifest><spine></spine>'),
  });
  const ir = epubToIr(epub);
  assert.equal(ir.title, 'T');
  assert.equal(ir.language, 'de');
  assert.equal(ir.identifier, 'urn:isbn:123');
  assert.deepEqual(ir.authors, ['Ann Writer', 'Bob Author']);
});

test('epubToIr defaults a missing title and language', () => {
  const ir = epubToIr(makeEpub({ opf: OPF('') }));
  assert.equal(ir.title, 'Untitled');
  assert.equal(ir.language, '');
});

test('epubToIr walks the spine in order and only takes (x)html items', () => {
  const opf = OPF('<dc:title>T</dc:title>').replace(
    '<manifest></manifest>',
    `<manifest>
       <item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>
       <item id="two" href="two.xhtml" media-type="application/xhtml+xml"/>
       <item id="css" href="s.css" media-type="text/css"/>
     </manifest>
     <spine><itemref idref="two"/><itemref idref="css"/><itemref idref="one"/></spine>`,
  );
  const ir = epubToIr(
    makeEpub({
      opf,
      files: {
        'OEBPS/one.xhtml': '<body><p>content ONE</p></body>',
        'OEBPS/two.xhtml': '<body><p>content TWO</p></body>',
        'OEBPS/s.css': 'body{}',
      },
    }),
  );
  assert.deepEqual(
    ir.chapters.map((c) => c.html.replace(/<[^>]+>/g, '').trim()),
    ['content TWO', 'content ONE'],
    'spine order (two, then one) kept, the css itemref skipped',
  );
});

test('epubToIr imports images and resolves the cover from a properties="cover-image" item', () => {
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(10)]);
  const opf = OPF('<dc:title>T</dc:title>').replace(
    '<manifest></manifest>',
    `<manifest>
       <item id="fig" href="img/f.gif" media-type="image/gif"/>
       <item id="cov" href="img/c.png" media-type="image/png" properties="cover-image"/>
       <item id="tail" href="img/t.jpg" media-type="image/jpeg"/>
     </manifest><spine></spine>`,
  );
  const ir = epubToIr(
    makeEpub({ opf, files: { 'OEBPS/img/c.png': PNG, 'OEBPS/img/f.gif': GIF, 'OEBPS/img/t.jpg': JPG } }),
  );
  assert.equal(ir.images.length, 3);
  // the cover must be the .png item in the MIDDLE: not images[0] (the .gif),
  // and not the last-seen item (the .jpg).
  assert.equal(ir.cover!.mime, 'image/png');
  assert.ok(ir.cover!.data.equals(PNG));
});

test('epubToIr treats only a <meta name="cover"> as a cover pointer, nothing else', () => {
  const opf = OPF(
    '<dc:title>T</dc:title>' +
      '<meta name="cover" content="realcover"/>' +
      '<meta property="dcterms:modified" content="2020"/>' +
      '<dc:date name="cover" content="hijack"/>', // NOT a <meta>: must not touch coverId
  ).replace(
    '<manifest></manifest>',
    `<manifest>
       <item id="first" href="a.png" media-type="image/png"/>
       <item id="realcover" href="b.gif" media-type="image/gif"/>
     </manifest><spine></spine>`,
  );
  const ir = epubToIr(makeEpub({ opf, files: { 'OEBPS/a.png': PNG, 'OEBPS/b.gif': GIF } }));
  // neither the trailing plain <meta> nor the <dc:date name="cover"> may overwrite
  // coverId; the cover stays b.gif (not the a.png fallback)
  assert.ok(ir.cover!.data.equals(GIF));
});

test('epubToIr collects text only for real dc:* elements, not any tag that ends in a dc key', () => {
  const opf = OPF('<abctitle>LEAK</abctitle><dc:title>Real Title</dc:title>').replace(
    '<manifest></manifest>', '<manifest></manifest><spine></spine>',
  );
  assert.equal(epubToIr(makeEpub({ opf })).title, 'Real Title', 'the <abctitle> text is not collected');
});

test('epubToIr does not crash when the cover pointer names a manifest item that does not exist', () => {
  const opf = OPF('<dc:title>T</dc:title><meta name="cover" content="nosuchitem"/>').replace(
    '<manifest></manifest>',
    `<manifest><item id="real" href="r.png" media-type="image/png"/></manifest><spine></spine>`,
  );
  const ir = epubToIr(makeEpub({ opf, files: { 'OEBPS/r.png': PNG } }));
  assert.ok(ir.cover!.data.equals(PNG), 'the bad pointer is ignored; the fallback image is the cover');
});

test('epubToIr also resolves the cover from a <meta name="cover"> reference', () => {
  const opf = OPF('<dc:title>T</dc:title><meta name="cover" content="thecover"/>').replace(
    '<manifest></manifest>',
    `<manifest>
       <item id="other" href="o.png" media-type="image/png"/>
       <item id="thecover" href="c.gif" media-type="image/gif"/>
     </manifest><spine></spine>`,
  );
  const ir = epubToIr(makeEpub({ opf, files: { 'OEBPS/o.png': PNG, 'OEBPS/c.gif': GIF } }));
  assert.ok(ir.cover!.data.equals(GIF), 'the <meta name="cover"> image, not just images[0]');
  assert.equal(ir.cover!.mime, 'image/gif');
});

test('epubToIr imports only the image manifest items', () => {
  const opf = OPF('<dc:title>T</dc:title>').replace(
    '<manifest></manifest>',
    `<manifest>
       <item id="pic" href="p.png" media-type="image/png"/>
       <item id="css" href="s.css" media-type="text/css"/>
       <item id="doc" href="d.xhtml" media-type="application/xhtml+xml"/>
     </manifest><spine></spine>`,
  );
  const ir = epubToIr(makeEpub({ opf, files: { 'OEBPS/p.png': PNG, 'OEBPS/s.css': 'x', 'OEBPS/d.xhtml': '<p/>' } }));
  assert.equal(ir.images.length, 1, 'the css and the xhtml are not images');
  assert.equal(ir.images[0].id, 'p.png');
});

test('epubToIr derives the cover mime from its href when the manifest item has none', () => {
  const opf = OPF('<dc:title>T</dc:title><meta name="cover" content="cov"/>').replace(
    '<manifest></manifest>',
    `<manifest><item id="cov" href="the-cover.gif" media-type=""/></manifest><spine></spine>`,
  );
  const ir = epubToIr(makeEpub({ opf, files: { 'OEBPS/the-cover.gif': GIF } }));
  assert.equal(ir.cover!.mime, 'image/gif', 'mimeFromName fills in the missing media-type');
});

test('epubToIr ignores a cover reference whose data is missing, and never crashes without a cover', () => {
  const opf = OPF('<dc:title>T</dc:title><meta name="cover" content="ghost"/>').replace(
    '<manifest></manifest>',
    `<manifest><item id="ghost" href="missing.png" media-type="image/png"/></manifest><spine></spine>`,
  );
  const ir = epubToIr(makeEpub({ opf })); // no missing.png file
  assert.equal(ir.cover, null, 'the dangling cover reference resolves to nothing');
});

test('epubToIr keeps a spine item when its type OR its href looks like (x)html', () => {
  const opf = OPF('<dc:title>T</dc:title>').replace(
    '<manifest></manifest>',
    `<manifest>
       <item id="xhtmlType" href="a.bin" media-type="application/xhtml+xml"/>
       <item id="htmlType" href="b.bin" media-type="text/html"/>
       <item id="htmlHref" href="c.html" media-type="application/octet-stream"/>
       <item id="htmHref" href="d.htm" media-type="application/octet-stream"/>
       <item id="midHtml" href="weird.html.txt" media-type="application/octet-stream"/>
       <item id="neither" href="e.bin" media-type="application/octet-stream"/>
     </manifest>
     <spine>
       <itemref idref="xhtmlType"/><itemref idref="htmlType"/><itemref idref="htmlHref"/>
       <itemref idref="htmHref"/><itemref idref="midHtml"/><itemref idref="neither"/><itemref idref="missing"/>
     </spine>`,
  );
  const ir = epubToIr(
    makeEpub({
      opf,
      files: {
        'OEBPS/a.bin': '<body><p>xhtml type</p></body>',
        'OEBPS/b.bin': '<body><p>html type</p></body>',
        'OEBPS/c.html': '<body><p>html href</p></body>',
        'OEBPS/d.htm': '<body><p>htm href</p></body>',
        'OEBPS/weird.html.txt': '<body><p>mid html</p></body>',
        'OEBPS/e.bin': '<body><p>excluded</p></body>',
      },
    }),
  );
  assert.deepEqual(
    ir.chapters.map((c) => c.html.replace(/<[^>]+>/g, '').trim()),
    ['xhtml type', 'html type', 'html href', 'htm href'],
    '.html must be at the END of the href; weird.html.txt does not qualify, nor does the plain binary',
  );
});

test('epubToIr collects dc:* text and nothing else, matching cur exactly', () => {
  // dc:title split across two text nodes (an entity) must both land in title;
  // a nested non-dc element inside must NOT leak into it.
  const opf = OPF('<dc:title>A &amp; B</dc:title><dc:subject>ignored</dc:subject>').replace(
    '<manifest></manifest>', '<manifest></manifest><spine></spine>',
  );
  const ir = epubToIr(makeEpub({ opf }));
  assert.equal(ir.title, 'A & B', 'both text pieces of dc:title kept, nothing from dc:subject');
});

test('epubToIr skips a spine chapter file that is missing from the archive', () => {
  const opf = OPF('<dc:title>T</dc:title>').replace(
    '<manifest></manifest>',
    `<manifest>
       <item id="here" href="here.xhtml" media-type="application/xhtml+xml"/>
       <item id="gone" href="gone.xhtml" media-type="application/xhtml+xml"/>
     </manifest><spine><itemref idref="gone"/><itemref idref="here"/></spine>`,
  );
  const ir = epubToIr(makeEpub({ opf, files: { 'OEBPS/here.xhtml': '<body><p>present</p></body>' } }));
  assert.deepEqual(ir.chapters.map((c) => c.html.replace(/<[^>]+>/g, '').trim()), ['present']);
});

test('epubToIr drops a chapter that is only whitespace once its <link>s are stripped', () => {
  const opf = OPF('<dc:title>T</dc:title>').replace(
    '<manifest></manifest>',
    `<manifest>
       <item id="empty" href="e.xhtml" media-type="application/xhtml+xml"/>
       <item id="full" href="f.xhtml" media-type="application/xhtml+xml"/>
     </manifest><spine><itemref idref="empty"/><itemref idref="full"/></spine>`,
  );
  const ir = epubToIr(
    makeEpub({
      opf,
      files: {
        // after sanitising and dropping both links this body is a lone space
        'OEBPS/e.xhtml': '<body><link rel="a" href="x"/> <link rel="b" href="y"/></body>',
        'OEBPS/f.xhtml': '<body><p>kept</p></body>',
      },
    }),
  );
  assert.deepEqual(ir.chapters.map((c) => c.html.replace(/<[^>]+>/g, '').trim()), ['kept']);
});

test('extractChapter strips a <link> that sits inside the body, with its attributes', () => {
  const { html } = extractChapter(
    '<body><p>a</p><link rel="stylesheet" type="text/css" href="s.css"/><p>b</p></body>',
    'x',
    emptyIr(),
  );
  assert.equal(html, '<p>a</p><p>b</p>', 'the body link is gone, not left and not replaced by text');
});

test('epubToIr keeps whitespace-sensitive metadata trimmed and reads lower/upper-case tags', () => {
  const opf = OPF('<dc:title>  Spacey Title  </dc:title><DC:LANGUAGE>en</DC:LANGUAGE>').replace(
    '<manifest></manifest>', '<manifest></manifest><spine></spine>',
  );
  const ir = epubToIr(makeEpub({ opf }));
  assert.equal(ir.title, 'Spacey Title', 'SAX trim:true strips the surrounding whitespace');
  assert.equal(ir.language, 'en', 'the upper-case DC:LANGUAGE tag is lowercased and read');
});

test('epubToIr falls back to the first image as the cover, and to a placeholder chapter', () => {
  const opf = OPF('<dc:title>T</dc:title>').replace(
    '<manifest></manifest>',
    `<manifest><item id="i" href="i.png" media-type="image/png"/></manifest><spine></spine>`,
  );
  const ir = epubToIr(makeEpub({ opf, files: { 'OEBPS/i.png': PNG } }));
  assert.ok(ir.cover!.data.equals(PNG), 'no marked cover -> images[0]');
  assert.deepEqual(ir.chapters, [{ title: 'T', html: '<p></p>' }], 'no spine -> placeholder');
});

// ---- irToEpub ---------------------------------------------------

const withIr = (over: Partial<Ir>): Ir => ({ ...emptyIr(), ...over });
const entries = (buf: Buffer) => new AdmZip(buf).getEntries();
const text = (buf: Buffer, name: string) => new AdmZip(buf).readAsText(name);

test('irToEpub writes a valid OCF: mimetype first and STORED, plus the fixed boilerplate', () => {
  const out = irToEpub(withIr({ chapters: [{ title: 'C', html: '<p>x</p>' }] }));
  const es = entries(out);
  assert.equal(es[0].entryName, 'mimetype', 'mimetype is the first entry');
  assert.equal((es[0].header as unknown as { method: number }).method, 0, 'and it is STORED');
  assert.equal(text(out, 'mimetype'), 'application/epub+zip');
  assert.equal(
    text(out, 'META-INF/container.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  assert.ok(text(out, 'OEBPS/style.css').includes('font-family:serif'));
});

test('irToEpub content.opf is exactly the expected package document', () => {
  const out = irToEpub(
    withIr({
      identifier: 'ID',
      title: 'T',
      language: 'en',
      authors: ['A B', 'C D'],
      images: [{ id: 'fig.png', mime: 'image/png', data: Buffer.from('FIG') }],
      cover: { mime: 'image/png', data: Buffer.from('PNGDATA') },
      chapters: [{ title: 'Ch1', html: '<p>a</p>' }, { title: '', html: '<p>b</p>' }],
    }),
  );
  const rawOpf = text(out, 'OEBPS/content.opf');
  assert.match(
    rawOpf,
    /<meta property="dcterms:modified">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/meta>/,
    'the modified timestamp has no fractional seconds',
  );
  const opf = rawOpf.replace(
    /<meta property="dcterms:modified">[^<]+<\/meta>/,
    '<meta property="dcterms:modified">DATE</meta>',
  );
  assert.equal(
    opf,
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">ID</dc:identifier>
    <dc:title>T</dc:title>
    <dc:language>en</dc:language>
    <dc:creator id="creator-0">A B</dc:creator>
    <dc:creator id="creator-1">C D</dc:creator>
    <meta property="dcterms:modified">DATE</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="chap-1" href="text/chapter-0001.xhtml" media-type="application/xhtml+xml"/>
    <item id="chap-2" href="text/chapter-0002.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="img-1" href="images/fig.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover-page"/>
    <itemref idref="chap-1"/>
    <itemref idref="chap-2"/>
  </spine>
</package>`,
  );
});

test('irToEpub toc.ncx is exactly the expected navigation document', () => {
  const out = irToEpub(
    withIr({ identifier: 'ID', title: 'T', chapters: [{ title: 'Alpha', html: '<p>x</p>' }, { title: '', html: '<p>y</p>' }] }),
  );
  assert.equal(
    text(out, 'OEBPS/toc.ncx'),
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="ID"/></head>
  <docTitle><text>T</text></docTitle>
  <navMap>
    <navPoint id="np-1" playOrder="1">
      <navLabel><text>Alpha</text></navLabel>
      <content src="text/chapter-0001.xhtml"/>
    </navPoint>
    <navPoint id="np-2" playOrder="2">
      <navLabel><text>Chapter 2</text></navLabel>
      <content src="text/chapter-0002.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
  );
});

test('irToEpub chapter and cover xhtml are exactly as expected', () => {
  const out = irToEpub(withIr({ title: 'Bk', cover: { mime: 'image/gif', data: Buffer.from('G') }, chapters: [{ title: 'H', html: '<p>a & b</p>' }] }));
  assert.equal(
    text(out, 'OEBPS/text/chapter-0001.xhtml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8"/><title>H</title>
<link rel="stylesheet" type="text/css" href="../style.css"/>
</head><body>
<h2>H</h2>
<p>a &amp; b</p>
</body></html>`,
  );
  assert.equal(
    text(out, 'OEBPS/text/cover.xhtml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>Cover</title></head>
<body style="margin:0;text-align:center"><img src="../images/cover.gif" alt="cover" style="max-width:100%;height:100vh"/></body></html>`,
  );
});

test('irToEpub: an untitled chapter has no heading and its <title> falls back to the book title', () => {
  const out = irToEpub(withIr({ title: 'The Book', chapters: [{ title: '', html: '<p>b</p>' }] }));
  assert.equal(
    text(out, 'OEBPS/text/chapter-0001.xhtml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8"/><title>The Book</title>
<link rel="stylesheet" type="text/css" href="../style.css"/>
</head><body>
<p>b</p>
</body></html>`,
    'no heading line at all - not an empty <h2> and not placeholder text',
  );
});

test('irToEpub builds one xhtml per chapter, numbered and headed', () => {
  const out = irToEpub(
    withIr({ chapters: [{ title: 'One', html: '<p>a</p>' }, { title: '', html: '<p>b</p>' }] }),
  );
  const names = entries(out).map((e) => e.entryName);
  assert.ok(names.includes('OEBPS/text/chapter-0001.xhtml'));
  assert.ok(names.includes('OEBPS/text/chapter-0002.xhtml'));
  const c1 = text(out, 'OEBPS/text/chapter-0001.xhtml');
  assert.match(c1, /<h2>One<\/h2>/, 'a titled chapter gets an <h2>');
  assert.match(c1, /<p>a<\/p>/);
  const c2 = text(out, 'OEBPS/text/chapter-0002.xhtml');
  assert.ok(!/<h2>/.test(c2), 'an untitled chapter gets no heading');
});

test('irToEpub emits a cover image, a cover page and marks the cover in the manifest + spine', () => {
  const out = irToEpub(
    withIr({ cover: { mime: 'image/png', data: PNG }, chapters: [{ title: 'C', html: '<p>x</p>' }] }),
  );
  const names = entries(out).map((e) => e.entryName);
  assert.ok(names.includes('OEBPS/images/cover.png'), 'the cover file uses .png from the mime');
  assert.ok(names.includes('OEBPS/text/cover.xhtml'), 'a cover page');
  const opf = text(out, 'OEBPS/content.opf');
  assert.match(opf, /properties="cover-image"/);
  assert.match(opf, /<meta name="cover" content="cover-image"\/>/);
  assert.match(opf, /<itemref idref="cover-page"\/>[\s\S]*<itemref idref="chap-1"\/>/, 'cover page first in the spine');
});

test('irToEpub with no cover: the content.opf is exactly the no-cover package document', () => {
  const out = irToEpub(withIr({ identifier: 'ID', title: 'T', language: 'en', authors: ['A'], chapters: [{ title: 'C', html: '<p>x</p>' }] }));
  assert.ok(!entries(out).some((e) => /cover/.test(e.entryName)), 'no cover.* files');
  const opf = text(out, 'OEBPS/content.opf')
    .replace(/<meta property="dcterms:modified">[^<]+<\/meta>/, '<meta property="dcterms:modified">DATE</meta>')
    .replace(/[ \t]+$/gm, ''); // ignore trailing whitespace on the empty-slot lines
  assert.equal(
    opf,
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">ID</dc:identifier>
    <dc:title>T</dc:title>
    <dc:language>en</dc:language>
    <dc:creator id="creator-0">A</dc:creator>
    <meta property="dcterms:modified">DATE</meta>

  </metadata>
  <manifest>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chap-1" href="text/chapter-0001.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chap-1"/>
  </spine>
</package>`,
    'the cover-meta and cover-page slots are empty, not placeholder text',
  );
});

test('irToEpub image file extension comes from the id, or falls back to the mime', () => {
  const out = irToEpub(
    withIr({
      images: [
        { id: 'named.gif', mime: 'image/png', data: Buffer.from('A') },
        { id: 'no-ext', mime: 'image/png', data: Buffer.from('B') },
      ],
      chapters: [{ title: '', html: '<p>x</p>' }],
    }),
  );
  const names = entries(out).map((e) => e.entryName);
  assert.ok(names.includes('OEBPS/images/named.gif'), 'the .gif from the id wins over the png mime');
  assert.ok(names.includes('OEBPS/images/no-ext.png'), 'no id extension -> .png from the mime');
});

test('irToEpub does not duplicate an image that is also the cover', () => {
  const out = irToEpub(
    withIr({
      cover: { mime: 'image/png', data: PNG },
      images: [{ id: 'dup', mime: 'image/png', data: PNG }],
      chapters: [{ title: 'C', html: '<p>x</p>' }],
    }),
  );
  const imgs = entries(out).filter((e) => e.entryName.startsWith('OEBPS/images/'));
  assert.equal(imgs.length, 1, 'just the cover image file');
});

test('irToEpub collapses two images that resolve to the same file name', () => {
  const A = Buffer.from('AAAA');
  const B = Buffer.from('BBBB');
  const out = irToEpub(
    withIr({
      images: [
        { id: 'same.png', mime: 'image/png', data: A },
        { id: 'same.png', mime: 'image/png', data: B },
      ],
      chapters: [{ title: '', html: '<p><img src="images/same.png"/></p>' }],
    }),
  );
  const imgs = entries(out).filter((e) => e.entryName === 'OEBPS/images/same.png');
  assert.equal(imgs.length, 1, 'the second same.png does not overwrite or re-add');
  assert.deepEqual(new AdmZip(out).readFile('OEBPS/images/same.png'), A, 'the first one wins');
  const opf = text(out, 'OEBPS/content.opf');
  assert.equal(opf.match(/href="images\/same\.png"/g)!.length, 1, 'listed once in the manifest');
});

test('irToEpub rewrites chapter image paths to ../images and lists every image in the manifest', () => {
  const out = irToEpub(
    withIr({
      images: [{ id: 'fig1.png', mime: 'image/png', data: PNG }],
      chapters: [{ title: '', html: '<p><img src="images/fig1.png"/></p>' }],
    }),
  );
  assert.match(text(out, 'OEBPS/text/chapter-0001.xhtml'), /<img src="\.\.\/images\/fig1\.png"\/>/);
  assert.match(text(out, 'OEBPS/content.opf'), /href="images\/fig1\.png" media-type="image\/png"/);
});

test('irToEpub defaults the author to Unknown and the language to en', () => {
  const out = irToEpub(withIr({ authors: [], language: '', chapters: [{ title: 'C', html: '<p>x</p>' }] }));
  const opf = text(out, 'OEBPS/content.opf');
  assert.match(opf, /<dc:creator id="creator-0">Unknown<\/dc:creator>/);
  assert.match(opf, /<dc:language>en<\/dc:language>/);
});

test('irToEpub toc.ncx has a navPoint per chapter in reading order', () => {
  const out = irToEpub(
    withIr({ chapters: [{ title: 'Alpha', html: '<p>x</p>' }, { title: '', html: '<p>y</p>' }] }),
  );
  const ncx = text(out, 'OEBPS/toc.ncx');
  assert.match(ncx, /<navLabel><text>Alpha<\/text><\/navLabel>/);
  assert.match(ncx, /<navLabel><text>Chapter 2<\/text><\/navLabel>/, 'untitled chapters get a default label');
  assert.match(ncx, /playOrder="1"[\s\S]*playOrder="2"/);
});

// ---- round trip ------------------------------------------------

test('irToEpub -> epubToIr preserves the metadata, chapters and cover', () => {
  const ir = withIr({
    title: 'Round Trip',
    language: 'fr',
    authors: ['Solo Writer'],
    cover: { mime: 'image/png', data: PNG },
    chapters: [
      { title: 'First', html: '<p>one</p>' },
      { title: 'Second', html: '<p>two</p>' },
    ],
  });
  const back = epubToIr(irToEpub(ir));
  assert.equal(back.title, 'Round Trip');
  assert.equal(back.language, 'fr');
  assert.deepEqual(back.authors, ['Solo Writer']);
  assert.ok(back.cover!.data.equals(PNG));
  const chapterText = back.chapters
    .map((c) => c.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  assert.deepEqual(
    chapterText.filter((t) => /one|two/.test(t)),
    ['First one', 'Second two'],
    'both real chapters survive the round trip (a cover page also rides along)',
  );
});
