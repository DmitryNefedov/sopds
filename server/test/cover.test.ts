import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { extractCover, parseBook } from '../src/formats/index.js';
import { decodeXmlBuffer } from '../src/formats/fb2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');

// 1x1 PNG and a tiny JPEG used as fake embedded covers.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8AH//Z',
  'base64',
);

const b64 = (buf: Buffer) => buf.toString('base64').replace(/(.{76})/g, '$1\n');

interface Fb2Opts {
  encoding?: string;
  cover?: boolean;
  coverpage?: boolean;
  img?: Buffer;
  titleBytes?: Buffer | null;
}
function fb2({ encoding = 'utf-8', cover = true, coverpage = true, img = PNG, titleBytes = null }: Fb2Opts = {}): Buffer {
  const title = titleBytes ? '__TITLE__' : 'Cover Test';
  const xml =
    `<?xml version="1.0" encoding="${encoding}"?>\n` +
    `<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">\n` +
    `<description><title-info><genre>prose</genre>` +
    `<author><first-name>A</first-name><last-name>B</last-name></author>` +
    `<book-title>${title}</book-title><lang>ru</lang>` +
    (coverpage ? `<coverpage><image l:href="#c.png"/></coverpage>` : '') +
    `</title-info></description>\n` +
    `<body><section><p>text</p></section></body>\n` +
    (cover
      ? `<binary id="c.png" content-type="image/png">\n${b64(img)}\n</binary>\n`
      : '') +
    `</FictionBook>`;
  if (!titleBytes) return Buffer.from(xml, 'utf8');
  // splice raw title bytes (e.g. cp1251) into the placeholder
  const [head, tail] = xml.split('__TITLE__');
  return Buffer.concat([Buffer.from(head, 'latin1'), titleBytes as Buffer, Buffer.from(tail, 'latin1')]);
}

test('fb2: extracts the referenced coverpage binary', () => {
  const c = extractCover(fb2({}), 'x.fb2');
  assert.ok(c, 'cover returned');
  assert.equal(c.mime, 'image/png');
  assert.ok(c.data.equals(PNG));
});

test('fb2: falls back to the first image binary when there is no coverpage', () => {
  const c = extractCover(fb2({ coverpage: false, img: JPG }), 'x.fb2');
  assert.ok(c);
  assert.ok(c.data.equals(JPG));
});

test('fb2: no cover when there are no image binaries', () => {
  assert.equal(extractCover(fb2({ cover: false }), 'x.fb2'), null);
});

test('fb2: tolerates base64 with embedded whitespace / newlines', () => {
  const messy = fb2({}).toString('utf8').replace(
    /<binary id="c.png"[^>]*>([\s\S]*?)<\/binary>/,
    (m: string, body: string) => m.replace(body, body.replace(/(.{10})/g, '$1  \n')),
  );
  const c = extractCover(Buffer.from(messy, 'utf8'), 'x.fb2');
  assert.ok(c && c.data.equals(PNG));
});

test('decodeXmlBuffer honours a windows-1251 declaration', () => {
  // "Тест" in cp1251
  const titleBytes = Buffer.from([0xd2, 0xe5, 0xf1, 0xf2]);
  const buf = fb2({ encoding: 'windows-1251', titleBytes });
  const text = decodeXmlBuffer(buf);
  assert.ok(text.includes('Тест'), 'cp1251 title decoded to Unicode');
  // cover still extracts from the same buffer
  const c = extractCover(buf, 'x.fb2');
  assert.ok(c && c.data.equals(PNG));
});

test('epub: extracts the cover image', () => {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  zip.addFile(
    'OEBPS/content.opf',
    Buffer.from(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
       <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">u</dc:identifier><dc:title>E</dc:title><dc:language>en</dc:language></metadata>
       <manifest><item id="cov" href="images/cover.png" media-type="image/png" properties="cover-image"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
       <spine><itemref idref="c1"/></spine></package>`,
    ),
  );
  zip.addFile('OEBPS/images/cover.png', PNG);
  zip.addFile('OEBPS/c1.xhtml', Buffer.from('<html><body><p>hi</p></body></html>'));

  const c = extractCover(zip.toBuffer(), 'x.epub');
  assert.ok(c, 'cover returned');
  assert.equal(c.mime, 'image/png');
  assert.ok(c.data.equals(PNG));
});

test('epub: resolves a cover path that uses ../', () => {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  zip.addFile(
    'content/book.opf',
    Buffer.from(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
       <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:identifier id="id">u</dc:identifier><dc:title>E</dc:title>
       <meta name="cover" content="cov"/></metadata>
       <manifest><item id="cov" href="../img/c.jpg" media-type="image/jpeg"/></manifest><spine/></package>`,
    ),
  );
  zip.addFile('img/c.jpg', JPG);

  const c = extractCover(zip.toBuffer(), 'x.epub');
  assert.ok(c, 'cover returned');
  assert.ok(c.data.equals(JPG));
});

test('mobi: extracts the cover from a converted file', async () => {
  // Build a real MOBI (with an embedded cover) via the converter, then read it back.
  const { irToMobi } = await import('../src/services/convert/mobi.js');
  const mobi = irToMobi({
    title: 'M',
    language: 'en',
    identifier: 'id',
    authors: ['A'],
    cover: { mime: 'image/jpeg', data: JPG },
    chapters: [{ title: '', html: '<p>hi</p>' }],
    images: [{ id: 'img00001', mime: 'image/jpeg', data: JPG }],
  });
  const c = extractCover(mobi, 'x.mobi');
  assert.ok(c, 'cover returned');
  assert.ok(c.data.equals(JPG));
});

test('mobi + epub metadata is read during a scan (not just the filename)', () => {
  const mobi = parseBook(fs.readFileSync(path.join(FIX, 'robin_cook.mobi')), 'robin_cook.mobi');
  assert.equal(mobi.title, 'Vector');
  assert.deepEqual(mobi.authors, ['Cook Robin']);

  const epub = parseBook(fs.readFileSync(path.join(FIX, 'mirer.epub')), 'mirer.epub');
  assert.equal(epub.title, 'У меня девять жизней (шф (продолжатели))');
  assert.deepEqual(epub.authors, ['Мирер Александр']);
});

test('real sample files still yield covers', () => {
  const cases: Array<[string, boolean]> = [
    ['262001.fb2', true],
    ['mirer.epub', true],
    ['robin_cook.mobi', true],
  ];
  for (const [file, hasCover] of cases) {
    const buf = fs.readFileSync(path.join(FIX, file));
    const c = extractCover(buf, file);
    if (hasCover) {
      assert.ok(c && c.data.length > 100, `${file}: expected a cover`);
      assert.ok(/^image\//.test(c.mime), `${file}: mime ${c.mime}`);
    }
  }
});
