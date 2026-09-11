import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  metaReadPlan,
  parseBook,
  extractCover,
  MOBI_HEAD_LIMIT,
  NO_BYTES,
} from '../src/formats/index.js';
import { FB2_HEAD_LIMIT } from '../src/formats/fb2.js';

const FIX = path.join(import.meta.dirname, 'fixtures');

// The format dispatcher: which bytes each format needs, parser routing, the
// filename-only fallback, and RawMeta -> BookMeta normalisation.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60)]);

const fb2 = (inner: string) =>
  Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>${inner}</title-info></description>` +
      `<binary id="c" content-type="image/png">${PNG.toString('base64')}</binary></FictionBook>`,
    'latin1',
  );

test('metaReadPlan returns the right plan per extension, case-insensitively', () => {
  assert.deepEqual(metaReadPlan('a.fb2'), {
    need: 'head',
    limit: FB2_HEAD_LIMIT,
    stopAt: Buffer.from('</description>', 'latin1'),
  });
  assert.deepEqual(metaReadPlan('X.FB2'), metaReadPlan('a.fb2'));
  assert.deepEqual(metaReadPlan('a.mobi'), { need: 'head', limit: MOBI_HEAD_LIMIT });
  assert.deepEqual(metaReadPlan('a.epub'), { need: 'all' });
  assert.deepEqual(metaReadPlan('a.pdf'), { need: 'none' });
  assert.deepEqual(metaReadPlan('a.djvu'), { need: 'none' });
  assert.deepEqual(metaReadPlan('noext'), { need: 'none' });
});

test('MOBI_HEAD_LIMIT and NO_BYTES are the documented constants', () => {
  assert.equal(MOBI_HEAD_LIMIT, 256 * 1024);
  assert.equal(NO_BYTES.length, 0);
});

test('parseBook routes .fb2 to the FB2 parser', () => {
  const m = parseBook(fb2('<book-title>Routed FB2</book-title><lang>en</lang>'), 'x.fb2');
  assert.equal(m.title, 'Routed FB2');
  assert.equal(m.format, 'fb2');
});

test('parseBook routes .mobi and .epub to their parsers (real fixtures)', () => {
  const mobi = parseBook(fs.readFileSync(path.join(FIX, 'robin_cook.mobi')), 'robin_cook.mobi');
  assert.equal(mobi.title, 'Vector', 'not the filename base "robin_cook"');
  assert.equal(mobi.format, 'mobi');

  const epub = parseBook(fs.readFileSync(path.join(FIX, 'mirer.epub')), 'mirer.epub');
  assert.equal(epub.title, 'У меня девять жизней (шф (продолжатели))');
  assert.equal(epub.format, 'epub');
});

test('extractCover routes .mobi to mobiCover', () => {
  const c = extractCover(fs.readFileSync(path.join(FIX, 'robin_cook.mobi')), 'robin_cook.mobi');
  assert.ok(c && c.data.length > 100 && /^image\//.test(c.mime));
});

test('extractCover routes .epub to parseEpub and returns null on a coverless one', () => {
  const c = extractCover(fs.readFileSync(path.join(FIX, 'mirer.epub')), 'mirer.epub');
  assert.ok(c && c.data.length > 100 && /^image\//.test(c.mime), 'real epub -> a cover');

  // A structurally valid epub with no image manifest items -> null.
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'));
  zip.addFile('c.opf', Buffer.from('<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>T</dc:title></metadata><manifest/></package>'));
  assert.equal(extractCover(zip.toBuffer(), 'x.epub'), null);
});

test('parseBook normalisation filters blank authors/genres out of the result', () => {
  // mobiMeta pushes an unfiltered EXTH-105 genre and can yield ''. Build a mobi
  // whose EXTH carries an empty genre and a real one.
  const exth = (entries: Array<[number, string]>) => {
    const recs = entries.map(([t, s]) => {
      const d = Buffer.from(s, 'utf8');
      const h = Buffer.alloc(8);
      h.writeUInt32BE(t, 0);
      h.writeUInt32BE(8 + d.length, 4);
      return Buffer.concat([h, d]);
    });
    const body = Buffer.concat(recs);
    const head = Buffer.alloc(12);
    head.write('EXTH', 0, 'latin1');
    head.writeUInt32BE(12 + body.length, 4);
    head.writeUInt32BE(recs.length, 8);
    return Buffer.concat([head, body]);
  };
  const HLEN = 0xf8;
  const mobi = Buffer.alloc(HLEN);
  mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(HLEN, 4);
  mobi.writeUInt32BE(65001, 12);
  mobi.writeUInt32BE(0x40, 0x80 - 16);
  const exthBuf = exth([[105, ''], [105, 'History'], [100, 'Ann Lee']]);
  mobi.writeUInt32BE(16 + HLEN + exthBuf.length, 0x54 - 16);
  mobi.writeUInt32BE(2, 0x58 - 16);
  const rec0 = Buffer.concat([Buffer.alloc(16), mobi, exthBuf, Buffer.from('Hi')]);
  const records = [rec0, Buffer.alloc(4)];
  const headerLen = 78 + records.length * 8 + 2;
  const head = Buffer.alloc(78);
  head.write('BOOK', 60, 'latin1');
  head.write('MOBI', 64, 'latin1');
  head.writeUInt16BE(records.length, 76);
  const recList = Buffer.alloc(records.length * 8 + 2);
  let off = headerLen;
  for (let i = 0; i < records.length; i++) { recList.writeUInt32BE(off, i * 8); off += records[i].length; }
  const buf = Buffer.concat([head, recList, ...records]);

  const m = parseBook(buf, 'x.mobi');
  assert.deepEqual(m.genres, ['history'], 'the empty EXTH-105 genre is filtered out');
  assert.deepEqual(m.authors, ['Lee Ann']);
});

test('parseBook normalisation leaves docdate/annotation as empty strings when absent', () => {
  const m = parseBook(fb2('<book-title>X</book-title>'), 'x.fb2');
  assert.equal(m.docdate, '');
  assert.equal(m.annotation, '');
  assert.equal(m.lang, '');
});

test('parseBook uses filename metadata (title + langCode) for formats it never introspects', () => {
  const m = parseBook(NO_BYTES, 'Мой Роман.pdf');
  assert.equal(m.title, 'Мой Роман', 'basename without the extension');
  assert.equal(m.format, 'pdf');
  assert.equal(m.langCode, 1, 'derived from the Cyrillic filename');
  assert.deepEqual(m.authors, []);
  assert.deepEqual(m.genres, []);
  assert.equal(m.lang, '');
});

test('parseBook returns a filename-derived record when a parser yields nothing', () => {
  const m = parseBook(Buffer.from('not fb2 at all'), 'The Manual.fb2');
  assert.equal(m.title, 'The Manual', 'empty parsed title -> filename base');
  assert.equal(m.format, 'fb2');
});

test('parseBook normalisation: clamps lengths, drops blank authors/genres, sets langCode', () => {
  const longTitle = 'T'.repeat(600);
  const longAnno = 'a'.repeat(11000);
  const m = parseBook(
    fb2(
      `<book-title>${longTitle}</book-title><lang>en</lang>` +
        `<author><last-name>Solo</last-name></author>` +
        `<genre>sf</genre>` +
        `<annotation>${longAnno}</annotation>`,
    ),
    'x.fb2',
  );
  assert.equal(m.title.length, 512, 'title clamped to 512');
  assert.equal(m.annotation.length, 10000, 'annotation clamped to 10000');
  assert.deepEqual(m.genres, ['sf']);
  assert.deepEqual(m.authors, ['Solo']);
});

test('parseBook normalisation: a series needs a title, and index is carried through', () => {
  const withSeries = parseBook(
    fb2(`<book-title>X</book-title><sequence name="Trilogy" number="2"/>`),
    'x.fb2',
  );
  assert.deepEqual(withSeries.series, { title: 'Trilogy', index: 2 });

  const noSeries = parseBook(fb2(`<book-title>X</book-title>`), 'x.fb2');
  assert.equal(noSeries.series, null);
});

test('parseBook normalisation: empty title falls back to the filename base', () => {
  const m = parseBook(fb2(`<lang>en</lang>`), 'Fallback Name.fb2');
  assert.equal(m.title, 'Fallback Name');
});

test('extractCover routes by extension and returns null on a miss', () => {
  const c = extractCover(fb2('<book-title>X</book-title>'), 'x.fb2');
  assert.ok(c, 'cover returned');
  assert.ok(c.data.equals(PNG));
  assert.equal(c.mime, 'image/png');

  assert.equal(extractCover(Buffer.from('garbage'), 'x.fb2'), null, 'unparseable fb2 -> null');
  assert.equal(extractCover(NO_BYTES, 'x.pdf'), null, 'no extractor for pdf');
});

test('extractCover returns null when neither the byte scan nor parseFb2 finds a cover', () => {
  // Upper-case tag hides it from the scanner; the payload is too small for parseFb2.
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
      `</title-info></description><BINARY ID="c" CONTENT-TYPE="image/png">${Buffer.alloc(8, 1).toString('base64')}</BINARY></FictionBook>`,
    'latin1',
  );
  assert.equal(extractCover(buf, 'x.fb2'), null);
});

test('extractCover falls back to parseFb2 when the byte scan misses', () => {
  // Upper-case <BINARY> tags: the byte scanner looks for a lower-case "<binary"
  // and misses, but the sax parser (lowercase: true) still finds the cover.
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
      `</title-info></description><BINARY CONTENT-TYPE="image/png" ID="c">${PNG.toString('base64')}</BINARY></FictionBook>`,
    'latin1',
  );
  const c = extractCover(buf, 'x.fb2');
  assert.ok(c, 'parseFb2 fallback resolved the cover');
  assert.ok(c.data.equals(PNG));
  assert.equal(c.mime, 'image/png', 'mime carried through from parseFb2');
});
