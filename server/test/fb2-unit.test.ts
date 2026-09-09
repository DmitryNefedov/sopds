import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeXmlBuffer,
  fb2Head,
  fb2Cover,
  parseFb2,
  looksLikeImage,
  sniffMime,
  FB2_HEAD_LIMIT,
  FB2_HEAD_MARKER,
} from '../src/formats/fb2.js';

// Byte-level helpers behind the FB2 parser. The fixture-driven happy paths live
// in cover.test.ts / formats.test.ts; this file pins the branch behaviour.

// --- image sniffing -------------------------------------------------------

const pad = (head: number[], len = 64) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, len - head.length), 0)]);

const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(58)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(52)]);
const SVG = Buffer.concat([Buffer.from('<svg xmlns="...">'), Buffer.alloc(48)]);
const XMLSVG = Buffer.concat([Buffer.from('<?xml version="1.0"?><svg/>'), Buffer.alloc(40)]);

test('sniffMime recognises each magic number', () => {
  assert.equal(sniffMime(JPEG), 'image/jpeg');
  assert.equal(sniffMime(PNG), 'image/png');
  assert.equal(sniffMime(GIF), 'image/gif');
  assert.equal(sniffMime(WEBP), 'image/webp');
  assert.equal(sniffMime(SVG), 'image/svg+xml');
  assert.equal(sniffMime(XMLSVG), 'image/svg+xml', 'a leading <?xml counts as SVG');
  assert.equal(sniffMime(Buffer.from(' <svg xmlns>')), 'image/svg+xml', 'one leading space is trimmed within the 5-byte window');
});

test('sniffMime rejects near-misses in every branch', () => {
  assert.equal(sniffMime(pad([0xff, 0xd8, 0x00, 0x00])), null, 'JPEG needs the third 0xff');
  assert.equal(sniffMime(pad([0xff, 0x00, 0xff, 0x00])), null, 'JPEG needs the second 0xd8');
  assert.equal(sniffMime(pad([0x00, 0xd8, 0xff, 0x00])), null, 'JPEG needs the first 0xff');
  assert.equal(sniffMime(pad([0x89, 0x50, 0x4e, 0x00])), null, 'PNG needs 0x47 in slot 4');
  assert.equal(sniffMime(pad([0x89, 0x50, 0x00, 0x47])), null, 'PNG needs 0x4e in slot 3');
  assert.equal(sniffMime(pad([0x89, 0x00, 0x4e, 0x47])), null, 'PNG needs 0x50 in slot 2');
  assert.equal(sniffMime(pad([0x00, 0x50, 0x4e, 0x47])), null, 'PNG needs 0x89 in slot 1');
  assert.equal(sniffMime(Buffer.concat([Buffer.from('GIx'), Buffer.alloc(10)])), null);
  assert.equal(
    sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBX'), Buffer.alloc(20)])),
    null,
    'RIFF without WEBP at offset 8',
  );
  assert.equal(
    sniffMime(Buffer.concat([Buffer.from('XIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)])),
    null,
    'WEBP without RIFF at offset 0',
  );
  assert.equal(sniffMime(Buffer.from('plain text, not markup at all')), null);
});

test('sniffMime guards short and missing buffers', () => {
  assert.equal(sniffMime(null), null);
  assert.equal(sniffMime(undefined), null);
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff])), null, 'needs at least 4 bytes');
  assert.equal(sniffMime(Buffer.alloc(4)), null);
});

test('looksLikeImage is exactly "sniffMime found something"', () => {
  assert.equal(looksLikeImage(JPEG), true);
  assert.equal(looksLikeImage(PNG), true);
  assert.equal(looksLikeImage(Buffer.from('nope')), false);
  assert.equal(looksLikeImage(null), false);
  assert.equal(looksLikeImage(undefined), false);
});

// --- encoding detection -------------------------------------------------

const CP1251_TEST = Buffer.from([0xd2, 0xe5, 0xf1, 0xf2]); // "Тест"
const UTF16LE_TEST = Buffer.from('Тест', 'utf16le');

test('decodeXmlBuffer follows the XML encoding declaration', () => {
  const doc = (enc: string, titleBytes: Buffer) =>
    Buffer.concat([
      Buffer.from(`<?xml version="1.0" encoding="${enc}"?><t>`, 'latin1'),
      titleBytes,
      Buffer.from('</t>', 'latin1'),
    ]);
  assert.ok(decodeXmlBuffer(doc('windows-1251', CP1251_TEST)).includes('Тест'));
  assert.ok(decodeXmlBuffer(doc('koi8-r', Buffer.from('Тест', 'latin1'))).length > 0);
  assert.ok(
    decodeXmlBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><t>Tëst</t>', 'utf8')).includes('Tëst'),
  );
});

test('decodeXmlBuffer treats utf8/ascii/us-ascii spellings as utf-8', () => {
  for (const enc of ['utf8', 'UTF8', 'ascii', 'us-ascii', 'US-ASCII']) {
    const buf = Buffer.from(`<?xml version="1.0" encoding="${enc}"?><t>Ïñ</t>`, 'utf8');
    assert.ok(decodeXmlBuffer(buf).includes('Ïñ'), enc);
  }
});

test('decodeXmlBuffer honours a BOM over the declaration', () => {
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<t>Тест</t>', 'utf16le')]);
  assert.ok(decodeXmlBuffer(utf16le).includes('Тест'));
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('<t>Тест</t>', 'utf16le').swap16()]);
  assert.ok(decodeXmlBuffer(utf16be).includes('Тест'));
  const utf8bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<t>Tëst</t>', 'utf8')]);
  assert.ok(decodeXmlBuffer(utf8bom).includes('Tëst'));
});

test('decodeXmlBuffer defaults to utf-8 and never throws on a bad encoding name', () => {
  assert.ok(decodeXmlBuffer(Buffer.from('<t>plain</t>', 'utf8')).includes('plain'));
  // An unknown label makes `new TextDecoder` throw; the catch falls back to utf8.
  const weird = Buffer.from('<?xml version="1.0" encoding="totally-made-up"?><t>hi</t>', 'utf8');
  assert.ok(decodeXmlBuffer(weird).includes('hi'));
});

// --- fb2Head clipping --------------------------------------------------

test('fb2Head returns the prefix through </description>', () => {
  const buf = Buffer.from('<a><description>meta</description>REST OF FILE', 'latin1');
  assert.equal(fb2Head(buf).toString('latin1'), '<a><description>meta</description>');
});

test('fb2Head returns the whole buffer when the marker is absent', () => {
  const buf = Buffer.from('<a><description>unterminated', 'latin1');
  assert.ok(fb2Head(buf).equals(buf));
});

test('fb2Head finds the marker in a UTF-16 buffer', () => {
  const le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('<description>x</description>tail', 'utf16le'),
  ]);
  const head = fb2Head(le);
  assert.ok(head.length < le.length, 'clipped');
  assert.ok(head.toString('utf16le').endsWith('</description>'));

  const be = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from('<description>x</description>tail', 'utf16le').swap16(),
  ]);
  const headBe = fb2Head(be);
  assert.ok(headBe.length < be.length && headBe.length > 4);
});

test('FB2 head constants are the documented values', () => {
  assert.equal(FB2_HEAD_LIMIT, 256 * 1024);
  assert.ok(FB2_HEAD_MARKER.equals(Buffer.from('</description>', 'latin1')));
});

// --- fb2Cover byte scan ----------------------------------------------

const B64 = (b: Buffer) => b.toString('base64');

function fb2Doc(binaries: string, opts: { coverId?: string } = {}) {
  const cover = opts.coverId
    ? `<coverpage><image l:href="#${opts.coverId}"/></coverpage>`
    : '';
  return Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook>` +
      `<description><title-info><book-title>T</book-title>${cover}</title-info></description>` +
      `<body><p>x</p></body>${binaries}</FictionBook>`,
    'latin1',
  );
}

test('fb2Cover returns the first image binary when none is marked as a cover', () => {
  const doc = fb2Doc(
    `<binary id="a" content-type="image/png">${B64(PNG)}</binary>` +
      `<binary id="b" content-type="image/jpeg">${B64(JPEG)}</binary>`,
  );
  const c = fb2Cover(doc);
  assert.ok(c);
  assert.equal(c.mime, 'image/png', 'first image wins');
  assert.ok(c.data.equals(PNG));
});

test('fb2Cover prefers a binary whose id contains "cover" over an earlier image', () => {
  const doc = fb2Doc(
    `<binary id="plain" content-type="image/png">${B64(PNG)}</binary>` +
      `<binary id="the-cover" content-type="image/jpeg">${B64(JPEG)}</binary>`,
  );
  const c = fb2Cover(doc);
  assert.ok(c && c.data.equals(JPEG), 'the "cover" id wins even though it is second');
});

test('fb2Cover matches a cover by id even without an image content-type', () => {
  const doc = fb2Doc(`<binary id="coverimg" content-type="application/octet-stream">${B64(PNG)}</binary>`);
  const c = fb2Cover(doc);
  assert.ok(c, 'matched on the id');
  assert.equal(c.mime, 'image/png', 'mime sniffed from the bytes, not the bogus content-type');
});

test('fb2Cover ignores non-image binaries that are not covers', () => {
  const doc = fb2Doc(`<binary id="notes" content-type="text/plain">${B64(Buffer.alloc(64, 65))}</binary>`);
  assert.equal(fb2Cover(doc), null);
});

test('fb2Cover rejects a payload that is too small or not an image', () => {
  assert.equal(fb2Cover(fb2Doc(`<binary id="a" content-type="image/png">${B64(Buffer.alloc(8, 1))}</binary>`)), null, 'under 32 bytes');
  assert.equal(fb2Cover(fb2Doc(`<binary id="a" content-type="image/png">${B64(Buffer.alloc(64, 1))}</binary>`)), null, 'big enough but not image bytes');
});

test('fb2Cover returns null when there are no binaries at all', () => {
  assert.equal(fb2Cover(fb2Doc('')), null);
});

test('fb2Cover keeps a declared image content-type verbatim', () => {
  const doc = fb2Doc(`<binary id="c" content-type="image/webp">${B64(WEBP)}</binary>`);
  const c = fb2Cover(doc);
  assert.ok(c);
  assert.equal(c.mime, 'image/webp');
});

// --- parseFb2 metadata ----------------------------------------------

const FB2 = (inner: string, opts: { enc?: string } = {}) =>
  Buffer.from(
    `<?xml version="1.0" encoding="${opts.enc ?? 'utf-8'}"?>` +
      `<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info>${inner}</title-info>` +
      `<document-info><date value="2001-05-01">May 2001</date></document-info></description></FictionBook>`,
    'utf8',
  );

test('parseFb2 pulls title, lang, genres and authors from title-info', () => {
  const m = parseFb2(
    FB2(
      `<genre>sci_fi</genre><genre>Adventure</genre>` +
        `<author><first-name>Arthur</first-name><last-name>Clarke</last-name></author>` +
        `<book-title>  Rendezvous  </book-title><lang> en </lang>`,
    ),
  );
  assert.equal(m.title, 'Rendezvous', 'trimmed');
  assert.equal(m.lang, 'en', 'trimmed');
  assert.deepEqual(m.genres, ['sci_fi', 'adventure'], 'lower-cased, trimmed');
  assert.deepEqual(m.authors, ['Clarke Arthur'], '"last first" order');
  assert.equal(m.langCode, 2, 'derived from the title script');
});

test('parseFb2 reads the document-info date from the value attribute', () => {
  const m = parseFb2(FB2(`<book-title>X</book-title>`));
  assert.equal(m.docdate, '2001-05-01', 'the value attribute, not the element text');
});

test('parseFb2 falls back to the date element text when there is no value attribute', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>` +
      `<book-title>X</book-title></title-info><document-info><date>1999-09-09</date></document-info>` +
      `</description></FictionBook>`,
    'utf8',
  );
  assert.equal(parseFb2(buf).docdate, '1999-09-09');
});

test('parseFb2 reads a series from the sequence element', () => {
  const m = parseFb2(FB2(`<book-title>X</book-title><sequence name=" Space Odyssey " number="3"/>`));
  assert.deepEqual(m.series, { title: 'Space Odyssey', index: 3 });
});

test('parseFb2 defaults a series with no number to index 0 and ignores a nameless sequence', () => {
  assert.deepEqual(parseFb2(FB2(`<book-title>X</book-title><sequence name="S"/>`)).series, { title: 'S', index: 0 });
  assert.equal(parseFb2(FB2(`<book-title>X</book-title><sequence number="2"/>`)).series, null);
});

test('parseFb2 leaves a single-token author untouched and keeps a comma author as written', () => {
  assert.deepEqual(parseFb2(FB2(`<book-title>X</book-title><author><last-name>Voltaire</last-name></author>`)).authors, ['Voltaire']);
  assert.deepEqual(
    parseFb2(FB2(`<book-title>X</book-title><author><first-name>Le Guin, Ursula</first-name></author>`)).authors,
    ['Le Guin, Ursula'],
  );
});

test('parseFb2 collapses annotation whitespace', () => {
  const m = parseFb2(FB2(`<book-title>X</book-title><annotation><p>one</p>  <p>two</p></annotation>`));
  assert.equal(m.annotation, 'one two');
});

test('parseFb2 clips at </description> under metaOnly and still finds the title', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>` +
      `<book-title>Clipped</book-title></title-info></description>` +
      `<binary id="c" content-type="image/png">${B64(PNG)}</binary></FictionBook>`,
    'latin1',
  );
  const meta = parseFb2(buf, { metaOnly: true });
  assert.equal(meta.title, 'Clipped');
  assert.equal(meta.coverData, null, 'no binary decoded under metaOnly');
  // Without metaOnly the same buffer yields the cover.
  assert.ok(parseFb2(buf).coverData?.equals(PNG));
});

test('parseFb2 is lenient with malformed XML', () => {
  const m = parseFb2(Buffer.from('<FictionBook><description><title-info><book-title>Broken', 'utf8'));
  assert.equal(m.title, 'Broken');
});

test('parseFb2 picks the referenced cover binary over other images', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info>` +
      `<book-title>X</book-title><coverpage><image l:href="#want"/></coverpage></title-info></description>` +
      `<binary id="other" content-type="image/png">${B64(PNG)}</binary>` +
      `<binary id="want" content-type="image/jpeg">${B64(JPEG)}</binary></FictionBook>`,
    'latin1',
  );
  const m = parseFb2(buf);
  assert.ok(m.coverData?.equals(JPEG), 'the #want binary, not the first one');
  assert.equal(m.coverMime, 'image/jpeg');
});
