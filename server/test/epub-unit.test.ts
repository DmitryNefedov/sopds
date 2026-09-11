import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { parseEpub, normalizePath } from '../src/formats/epub.js';

// EPUB package-document parsing and the four-step cover resolution. Built on
// hand-assembled zips so every branch has a fixture.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

interface EpubParts {
  opfPath?: string;
  container?: string | null;
  metadata?: string;
  manifest?: string;
  extraFiles?: Record<string, Buffer>;
}

function epub({
  opfPath = 'OEBPS/content.opf',
  container = undefined,
  metadata = '<dc:title>T</dc:title>',
  manifest = '',
  extraFiles = {},
}: EpubParts = {}): Buffer {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  const containerXml =
    container === null
      ? null
      : container ??
        `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  if (containerXml !== null) zip.addFile('META-INF/container.xml', Buffer.from(containerXml));
  zip.addFile(
    opfPath,
    Buffer.from(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="id">` +
        `<metadata>${metadata}</metadata><manifest>${manifest}</manifest><spine/></package>`,
    ),
  );
  for (const [name, data] of Object.entries(extraFiles)) zip.addFile(name, data);
  return zip.toBuffer();
}

test('parseEpub reads the core Dublin Core fields', () => {
  const m = parseEpub(
    epub({
      metadata:
        `<dc:title>  The   Left Hand  </dc:title>` +
        `<dc:creator>Ursula LeGuin</dc:creator>` +
        `<dc:language> en </dc:language>` +
        `<dc:subject>SciFi</dc:subject><dc:subject>Feminism</dc:subject>` +
        `<dc:description>a  planet</dc:description>` +
        `<dc:date>1969-03-01</dc:date>`,
    }),
  );
  assert.equal(m.title, 'The Left Hand', 'whitespace collapsed and trimmed');
  assert.deepEqual(m.authors, ['LeGuin Ursula'], 'last token moved to front');
  assert.equal(m.lang, 'en');
  assert.deepEqual(m.genres, ['scifi', 'feminism'], 'lower-cased');
  assert.equal(m.annotation, 'a planet');
  assert.equal(m.docdate, '1969-03-01');
  assert.equal(m.langCode, 2);
});

test('parseEpub keeps only the first dc:title', () => {
  const m = parseEpub(epub({ metadata: '<dc:title>Real</dc:title><dc:title>Subtitle</dc:title>' }));
  assert.equal(m.title, 'Real');
});

test('parseEpub keeps a comma-form author as written and a single token untouched', () => {
  assert.deepEqual(parseEpub(epub({ metadata: '<dc:title>T</dc:title><dc:creator>Le Guin, Ursula</dc:creator>' })).authors, ['Le Guin, Ursula']);
  assert.deepEqual(parseEpub(epub({ metadata: '<dc:title>T</dc:title><dc:creator>Voltaire</dc:creator>' })).authors, ['Voltaire']);
  assert.deepEqual(parseEpub(epub({ metadata: '<dc:title>T</dc:title><dc:creator>  </dc:creator>' })).authors, [], 'blank creator dropped');
});

test('parseEpub reads a Calibre series and index from meta elements', () => {
  const m = parseEpub(
    epub({
      metadata:
        '<dc:title>T</dc:title>' +
        '<meta name="calibre:series" content="Earthsea"/>' +
        '<meta name="calibre:series_index" content="4"/>',
    }),
  );
  assert.deepEqual(m.series, { title: 'Earthsea', index: 4 });
});

test('parseEpub ignores series_index when no series was given, and defaults a bad index to 0', () => {
  assert.equal(parseEpub(epub({ metadata: '<dc:title>T</dc:title><meta name="calibre:series_index" content="2"/>' })).series, null);
  const m = parseEpub(
    epub({ metadata: '<dc:title>T</dc:title><meta name="calibre:series" content="S"/><meta name="calibre:series_index" content="xx"/>' }),
  );
  assert.deepEqual(m.series, { title: 'S', index: 0 });
});

// --- cover resolution priority ----------------------------------------

test('cover step 1: an EPUB3 properties="cover-image" item wins', () => {
  const m = parseEpub(
    epub({
      manifest:
        `<item id="a" href="a.png" media-type="image/png"/>` +
        `<item id="c" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`,
      extraFiles: { 'OEBPS/a.png': PNG, 'OEBPS/cover.jpg': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(JPEG));
  assert.equal(m.coverMime, 'image/jpeg');
});

test('cover step 2: <meta name="cover"> points at a manifest id', () => {
  const m = parseEpub(
    epub({
      metadata: '<dc:title>T</dc:title><meta name="cover" content="thecover"/>',
      manifest:
        `<item id="x" href="x.png" media-type="image/png"/>` +
        `<item id="thecover" href="img/c.jpg" media-type="image/jpeg"/>`,
      extraFiles: { 'OEBPS/x.png': PNG, 'OEBPS/img/c.jpg': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(JPEG), 'the referenced id, not the first image');
});

test('cover step 3: an image whose id or href mentions "cover"', () => {
  const m = parseEpub(
    epub({
      manifest:
        `<item id="p1" href="page1.png" media-type="image/png"/>` +
        `<item id="the-cover-img" href="z.jpg" media-type="image/jpeg"/>`,
      extraFiles: { 'OEBPS/page1.png': PNG, 'OEBPS/z.jpg': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(JPEG));
});

test('cover step 4: fall back to the first image in the manifest', () => {
  const m = parseEpub(
    epub({
      manifest:
        `<item id="first" href="1.png" media-type="image/png"/>` +
        `<item id="second" href="2.jpg" media-type="image/jpeg"/>`,
      extraFiles: { 'OEBPS/1.png': PNG, 'OEBPS/2.jpg': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(PNG), 'first manifest image');
});

test('an image is recognised by extension even without an image/* media-type', () => {
  const m = parseEpub(
    epub({
      manifest: `<item id="c" href="cover.PNG" media-type="application/octet-stream"/>`,
      extraFiles: { 'OEBPS/cover.PNG': PNG },
    }),
  );
  assert.ok(m.coverData?.equals(PNG));
  assert.equal(m.coverMime, 'image/png', 'mime sniffed from bytes when media-type is not image/*');
});

test('cover href is resolved relative to the OPF, stripping fragments and query', () => {
  const m = parseEpub(
    epub({
      opfPath: 'book/package.opf',
      manifest: `<item id="c" href="../images/c.jpg?v=2#x" media-type="image/jpeg" properties="cover-image"/>`,
      extraFiles: { 'images/c.jpg': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(JPEG), 'resolved ../images/c.jpg next to book/');
});

test('cover href is percent-decoded before lookup', () => {
  const m = parseEpub(
    epub({
      manifest: `<item id="c" href="my%20cover.jpg" media-type="image/jpeg" properties="cover-image"/>`,
      extraFiles: { 'OEBPS/my cover.jpg': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(JPEG));
});

test('metaOnly skips cover extraction entirely', () => {
  const m = parseEpub(
    epub({
      manifest: `<item id="c" href="c.png" media-type="image/png" properties="cover-image"/>`,
      extraFiles: { 'OEBPS/c.png': PNG },
    }),
    { metaOnly: true },
  );
  assert.equal(m.coverData, null);
});

test('a manifest cover entry pointing at a missing / non-image file yields no cover', () => {
  assert.equal(
    parseEpub(
      epub({
        manifest: `<item id="c" href="gone.png" media-type="image/png" properties="cover-image"/>`,
      }),
    ).coverData,
    null,
    'entry not in the zip',
  );
  assert.equal(
    parseEpub(
      epub({
        manifest: `<item id="c" href="c.png" media-type="image/png" properties="cover-image"/>`,
        extraFiles: { 'OEBPS/c.png': Buffer.alloc(40, 7) },
      }),
    ).coverData,
    null,
    'present but not image bytes',
  );
});

// --- container / opf discovery --------------------------------------

test('parseEpub follows the container.xml full-path to a non-default OPF', () => {
  const m = parseEpub(epub({ opfPath: 'x/y/book.opf', metadata: '<dc:title>Nested</dc:title>' }));
  assert.equal(m.title, 'Nested');
});

test('parseEpub falls back to OEBPS/content.opf when container.xml is absent', () => {
  const m = parseEpub(epub({ opfPath: 'OEBPS/content.opf', container: null, metadata: '<dc:title>Fallback</dc:title>' }));
  assert.equal(m.title, 'Fallback');
});

test('parseEpub returns langCode 9 for a non-zip buffer', () => {
  const m = parseEpub(Buffer.from('this is not a zip file at all'));
  assert.equal(m.langCode, 9);
  assert.equal(m.title, '');
});

test('parseEpub returns langCode 9 when no package document can be found', () => {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="nowhere/book.opf"/></rootfiles></container>',
    ),
  );
  const m = parseEpub(zip.toBuffer());
  assert.equal(m.langCode, 9);
});

test('parseEpub is lenient with a malformed package document', () => {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('content.opf', Buffer.from('<package><metadata><dc:title xmlns:dc="x">Half'));
  const m = parseEpub(zip.toBuffer());
  assert.equal(m.title, 'Half', 'whatever parsed before the truncation survives');
});

test('parseEpub uses the default content.opf only when container.xml has no full-path', () => {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile/></rootfiles></container>'));
  zip.addFile('content.opf', Buffer.from('<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Rooted</dc:title></metadata></package>'));
  assert.equal(parseEpub(zip.toBuffer()).title, 'Rooted');
});

test('parseEpub only captures text for the six Dublin Core elements', () => {
  // dc:identifier / dc:publisher carry text but are not captured; nothing must
  // leak into title, docdate, annotation, etc.
  const m = parseEpub(
    epub({
      metadata:
        `<dc:identifier id="id">urn:x</dc:identifier>` +
        `<dc:publisher>Penguin</dc:publisher>` +
        `<dc:title>Only This</dc:title>` +
        `<dc:date>2020</dc:date>`,
    }),
  );
  assert.equal(m.title, 'Only This');
  assert.equal(m.docdate, '2020');
  assert.equal(m.annotation, '');
});

test('parseEpub keeps only the first dc:title (titleSeen latches on its close)', () => {
  assert.equal(parseEpub(epub({ metadata: '<dc:title>First</dc:title><dc:title>Second</dc:title>' })).title, 'First');
  assert.equal(
    parseEpub(epub({ metadata: '<dc:title>Chunk<!--x-->ed</dc:title>' })).title,
    'Chunked',
    'a comment splits the text but capture stays on "title"',
  );
});

test('parseEpub drops a creator/subject that has no text, keeping state clean', () => {
  const m = parseEpub(
    epub({
      metadata:
        `<dc:title>T</dc:title>` +
        `<dc:creator></dc:creator><dc:creator>Real Author</dc:creator>` +
        `<dc:subject></dc:subject><dc:subject>fantasy</dc:subject>`,
    }),
  );
  assert.deepEqual(m.authors, ['Author Real']);
  assert.deepEqual(m.genres, ['fantasy']);
});

test('parseEpub reorders a 3-token author name last-token-first', () => {
  assert.deepEqual(
    parseEpub(epub({ metadata: '<dc:title>T</dc:title><dc:creator>Ann B Charles</dc:creator>' })).authors,
    ['Charles Ann B'],
  );
});

test('parseEpub trims lang and docdate', () => {
  const m = parseEpub(epub({ metadata: '<dc:title>T</dc:title><dc:language>  fr  </dc:language><dc:date>  2019-01-01  </dc:date>' }));
  assert.equal(m.lang, 'fr');
  assert.equal(m.docdate, '2019-01-01');
});

test('parseEpub separates annotation text split by a comment', () => {
  assert.equal(
    parseEpub(epub({ metadata: '<dc:title>T</dc:title><dc:description>one<!--x-->two</dc:description>' })).annotation,
    'one two',
    'the two text chunks get a separator, not "onetwo"',
  );
});

test('the <meta name="cover"> match is exact', () => {
  const m = parseEpub(
    epub({
      metadata: '<dc:title>T</dc:title><meta name="covers" content="jp"/>',
      manifest: `<item id="pn" href="p.png" media-type="image/png"/><item id="jp" href="c.jpg" media-type="image/jpeg"/>`,
      extraFiles: { 'OEBPS/p.png': PNG, 'OEBPS/c.jpg': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(PNG), '"covers" != "cover": no coverId, so the first image (p.png) wins');
});

test('calibre:series_index without a preceding calibre:series is ignored', () => {
  assert.equal(
    parseEpub(epub({ metadata: '<dc:title>T</dc:title><meta name="calibre:series_index" content="5"/>' })).series,
    null,
  );
});

test('calibre:series_index is only applied for that exact meta name', () => {
  // A later <meta name="cover"> must not overwrite the series index with 0.
  const m = parseEpub(
    epub({
      metadata:
        '<dc:title>T</dc:title>' +
        '<meta name="calibre:series" content="Saga"/>' +
        '<meta name="calibre:series_index" content="7"/>' +
        '<meta name="cover" content="x"/>',
    }),
  );
  assert.deepEqual(m.series, { title: 'Saga', index: 7 });
});

test('parseEpub trims a subject and drops an all-whitespace one', () => {
  const m = parseEpub(
    epub({ metadata: '<dc:title>T</dc:title><dc:subject>  Sci Fi  </dc:subject><dc:subject>   </dc:subject>' }),
  );
  assert.deepEqual(m.genres, ['sci fi'], 'trimmed, lower-cased, and the blank one dropped');
});

test('the image filter recognises a bare .jpg href (media-type not image/*)', () => {
  const m = parseEpub(
    epub({
      manifest: `<item id="a" href="only.jpg" media-type="application/xhtml+xml"/>`,
      extraFiles: { 'OEBPS/only.jpg': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(JPEG), '.jpg (optional "e") is an image');
});

test('the image filter anchors the extension at the end of the href', () => {
  const m = parseEpub(
    epub({
      manifest:
        `<item id="a" href="notes.png.xhtml" media-type="application/xhtml+xml"/>` +
        `<item id="b" href="real.png" media-type="application/octet-stream"/>`,
      extraFiles: { 'OEBPS/notes.png.xhtml': Buffer.from('<html/>'), 'OEBPS/real.png': PNG },
    }),
  );
  assert.ok(m.coverData?.equals(PNG), '"notes.png.xhtml" is not an image; "real.png" is');
});

test('the image filter keeps an image/* item whose href has no extension', () => {
  const m = parseEpub(
    epub({
      manifest: `<item id="c" href="coverblob" media-type="image/png"/>`,
      extraFiles: { 'OEBPS/coverblob': PNG },
    }),
  );
  assert.ok(m.coverData?.equals(PNG), 'media-type image/png alone makes it an image');
});

test('cover step 2 only runs when steps 1 found nothing', () => {
  // properties="cover-image" (step 1) must win over <meta name="cover"> (step 2).
  const m = parseEpub(
    epub({
      metadata: '<dc:title>T</dc:title><meta name="cover" content="meta-one"/>',
      manifest:
        `<item id="meta-one" href="m.png" media-type="image/png"/>` +
        `<item id="prop-one" href="p.jpg" media-type="image/jpeg" properties="cover-image"/>`,
      extraFiles: { 'OEBPS/m.png': PNG, 'OEBPS/p.jpg': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(JPEG), 'the properties="cover-image" item wins');
});

test('<meta name="cover"> sets the cover id only for name exactly "cover"', () => {
  const m = parseEpub(
    epub({
      metadata:
        '<dc:title>T</dc:title>' +
        '<meta name="calibre:series" content="S"/>' +
        '<meta name="cover" content="thecov"/>',
      manifest:
        `<item id="first" href="a.png" media-type="image/png"/>` +
        `<item id="thecov" href="real.jpg" media-type="image/jpeg"/>`,
      extraFiles: { 'OEBPS/a.png': PNG, 'OEBPS/real.jpg': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(JPEG), 'coverId came from name="cover", not name="calibre:series"');
});

test('cover step 3 matches "cover" in an id OR an href', () => {
  const byId = parseEpub(
    epub({
      manifest: `<item id="p1" href="1.png" media-type="image/png"/><item id="the-cover" href="x.jpg" media-type="image/jpeg"/>`,
      extraFiles: { 'OEBPS/1.png': PNG, 'OEBPS/x.jpg': JPEG },
    }),
  );
  assert.ok(byId.coverData?.equals(JPEG), 'matched on id');
  const byHref = parseEpub(
    epub({
      manifest: `<item id="p1" href="1.png" media-type="image/png"/><item id="x2" href="the_cover.jpg" media-type="image/jpeg"/>`,
      extraFiles: { 'OEBPS/1.png': PNG, 'OEBPS/the_cover.jpg': JPEG },
    }),
  );
  assert.ok(byHref.coverData?.equals(JPEG), 'matched on href');
});

test('cover href resolution strips a fragment/query and percent-decodes, relative to the opf dir', () => {
  const m = parseEpub(
    epub({
      opfPath: 'a/b/pkg.opf',
      manifest: `<item id="c" href="../img/my%20cover.png?x=1#y" media-type="image/png" properties="cover-image"/>`,
      extraFiles: { 'a/img/my cover.png': PNG },
    }),
  );
  assert.ok(m.coverData?.equals(PNG), 'resolved to a/img/my cover.png');
});

test('cover falls back to the bare href when the resolved path is not in the zip', () => {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="d/pkg.opf"/></rootfiles></container>'));
  zip.addFile(
    'd/pkg.opf',
    Buffer.from(
      `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>T</dc:title></metadata>` +
        `<manifest><item id="c" href="cover.png" media-type="image/png" properties="cover-image"/></manifest></package>`,
    ),
  );
  // Not at d/cover.png (the resolved path); stored at the bare "cover.png".
  zip.addFile('cover.png', PNG);
  assert.ok(parseEpub(zip.toBuffer()).coverData?.equals(PNG), 'second candidate (bare href) hit');
});

test('cover extraction skips a candidate that is present but not an image', () => {
  const m = parseEpub(
    epub({
      manifest: `<item id="c" href="c.png" media-type="image/png" properties="cover-image"/>`,
      extraFiles: { 'OEBPS/c.png': Buffer.from('<html>not an image</html>') },
    }),
  );
  assert.equal(m.coverData, null);
});

test('parseEpub ignores empty text nodes', () => {
  // Whitespace-only text between elements must not blank out or pad a field.
  const m = parseEpub(epub({ metadata: '<dc:title>\n  Trimmed\n  </dc:title>\n  <dc:language>\n en \n</dc:language>' }));
  assert.equal(m.title, 'Trimmed');
  assert.equal(m.lang, 'en');
});

test('cover step 2 can point at a manifest item that is not in the image list', () => {
  // The referenced item has no image media-type and a non-image href, so it is
  // only reachable via the <meta name="cover"> id lookup against the full manifest.
  const m = parseEpub(
    epub({
      metadata: '<dc:title>T</dc:title><meta name="cover" content="weird"/>',
      manifest:
        `<item id="p" href="p.png" media-type="image/png"/>` +
        `<item id="weird" href="cover_blob" media-type="application/octet-stream"/>`,
      extraFiles: { 'OEBPS/p.png': PNG, 'OEBPS/cover_blob': JPEG },
    }),
  );
  assert.ok(m.coverData?.equals(JPEG));
});

test('a properties="cover-image" item that is missing from the zip still resolves via OEBPS/', () => {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
  zip.addFile(
    'book.opf',
    Buffer.from(
      `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>T</dc:title></metadata>` +
        `<manifest><item id="c" href="c.png" media-type="image/png" properties="cover-image"/></manifest></package>`,
    ),
  );
  // File lives under OEBPS/ even though the opf is at the root and says "c.png".
  zip.addFile('OEBPS/c.png', PNG);
  assert.ok(parseEpub(zip.toBuffer()).coverData?.equals(PNG), 'third candidate "OEBPS/c.png" hit');
});

test('parseEpub prefers the declared image media-type for coverMime, else sniffs', () => {
  const declared = parseEpub(
    epub({
      manifest: `<item id="c" href="c.bin" media-type="image/gif" properties="cover-image"/>`,
      extraFiles: { 'OEBPS/c.bin': PNG }, // bytes say png, manifest says gif
    }),
  );
  assert.equal(declared.coverMime, 'image/gif', 'declared image/* type wins');

  const sniffed = parseEpub(
    epub({
      manifest: `<item id="c" href="c.bin" media-type="application/octet-stream" properties="cover-image"/>`,
      extraFiles: { 'OEBPS/c.bin': PNG },
    }),
  );
  assert.equal(sniffed.coverMime, 'image/png', 'non-image media-type -> sniff the bytes');
});

// --- normalizePath -------------------------------------------------

test('normalizePath drops "." and empty segments and applies ".."', () => {
  assert.equal(normalizePath('a/b/c'), 'a/b/c');
  assert.equal(normalizePath('a/./b'), 'a/b', '"." is dropped');
  assert.equal(normalizePath('a//b'), 'a/b', 'empty segment dropped');
  assert.equal(normalizePath('a/b/../c'), 'a/c', '".." pops the previous segment');
  assert.equal(normalizePath('a/b/../../c'), 'c', 'two ".." pop two segments');
  assert.equal(normalizePath('../x'), 'x', '".." on an empty stack is a harmless no-op');
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath('./'), '');
});
