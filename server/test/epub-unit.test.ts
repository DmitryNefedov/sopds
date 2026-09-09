import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { parseEpub } from '../src/formats/epub.js';

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
  const m = parseEpub({} && epub({ metadata: '<dc:title>Real</dc:title><dc:title>Subtitle</dc:title>' }));
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
