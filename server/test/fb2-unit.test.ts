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
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0x99])), 'image/jpeg', 'exactly 4 bytes is enough');
});

test('sniffMime needs "<svg" at the very start, not merely contained', () => {
  assert.equal(sniffMime(Buffer.from('<svgx viewBox')), 'image/svg+xml', 'startsWith is fine');
  assert.equal(sniffMime(Buffer.from('x<svg y')), null, 'not at position 0 within the window');
  assert.equal(sniffMime(Buffer.from('</sv>')), null);
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

test('decodeXmlBuffer accepts the utf8/ascii/us-ascii label spellings', () => {
  for (const enc of ['utf8', 'UTF8', 'utf-8', 'us-ascii']) {
    const buf = Buffer.from(`<?xml version="1.0" encoding="${enc}"?><t>plain ascii</t>`, 'utf8');
    assert.ok(decodeXmlBuffer(buf).includes('plain ascii'), enc);
  }
});

test('decodeXmlBuffer honours a BOM over a conflicting declaration', () => {
  // Each buffer carries a windows-1251 declaration but a BOM for another
  // encoding; the BOM must win, so the cp1251 bytes stay untouched garbage and
  // the ASCII structure decodes cleanly.
  const decl = '<?xml version="1.0" encoding="windows-1251"?><t>OK</t>';
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(decl, 'utf16le')]);
  assert.ok(decodeXmlBuffer(utf16le).includes('OK'), 'utf-16le BOM beats the declaration');
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(decl, 'utf16le').swap16()]);
  assert.ok(decodeXmlBuffer(utf16be).includes('OK'), 'utf-16be BOM beats the declaration');

  // utf-8 BOM + cp1251 declaration + a real UTF-8 é: decoded as cp1251 the two
  // bytes of é would be two chars, so the BOM path is observable.
  const utf8 = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('<?xml version="1.0" encoding="windows-1251"?><t>café</t>', 'utf8'),
  ]);
  assert.ok(decodeXmlBuffer(utf8).includes('café'), 'utf-8 BOM beats the declaration');
});

test('decodeXmlBuffer needs every BOM byte, at its own position, to match', () => {
  const body = Buffer.from('<?xml version="1.0" encoding="windows-1251"?><t>café</t>', 'utf8');
  const isBom = (prefix: number[]) =>
    decodeXmlBuffer(Buffer.concat([Buffer.from(prefix), body])).includes('café');
  assert.ok(isBom([0xef, 0xbb, 0xbf]), 'the real utf-8 BOM is honoured');
  assert.ok(!isBom([0x00, 0xbb, 0xbf]), 'byte 0 must be 0xEF');
  assert.ok(!isBom([0xef, 0x00, 0xbf]), 'byte 1 must be 0xBB');
  assert.ok(!isBom([0xef, 0xbb, 0x00]), 'byte 2 must be 0xBF');

  const le = Buffer.from('<t>OK</t>', 'utf16le');
  const isLe = (prefix: number[]) =>
    decodeXmlBuffer(Buffer.concat([Buffer.from(prefix), le])).includes('OK');
  assert.ok(isLe([0xff, 0xfe]), 'the real utf-16le BOM is honoured');
  assert.ok(!isLe([0x00, 0xfe]), 'utf-16le byte 0 must be 0xFF');
  assert.ok(!isLe([0xff, 0x00]), 'utf-16le byte 1 must be 0xFE');

  const be = Buffer.from('<t>OK</t>', 'utf16le').swap16();
  const isBe = (prefix: number[]) =>
    decodeXmlBuffer(Buffer.concat([Buffer.from(prefix), be])).includes('OK');
  assert.ok(isBe([0xfe, 0xff]), 'the real utf-16be BOM is honoured');
  assert.ok(!isBe([0x00, 0xff]), 'utf-16be byte 0 must be 0xFE');
  assert.ok(!isBe([0xfe, 0x00]), 'utf-16be byte 1 must be 0xFF');
});

test('decodeXmlBuffer accepts an upper-case encoding label', () => {
  const buf = Buffer.from('<?xml version="1.0" encoding="WINDOWS-1251"?><t>', 'latin1');
  const full = Buffer.concat([buf, Buffer.from([0xd2, 0xe5, 0xf1, 0xf2]), Buffer.from('</t>', 'latin1')]);
  assert.ok(decodeXmlBuffer(full).includes('Тест'), 'WINDOWS-1251 label works');
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

test('fb2Head uses the ASCII marker unless a real UTF-16 BOM is present', () => {
  const ascii = '<description>x</description>tail';
  // Leading 0xFF 0x00 is not a utf-16le BOM, so the latin1 marker must still hit.
  const nearLe = Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(ascii, 'latin1')]);
  assert.ok(fb2Head(nearLe).toString('latin1').endsWith('</description>'));
  assert.ok(fb2Head(nearLe).length < nearLe.length, 'clipped via the latin1 marker');
  // Leading 0xFE 0x00 is not a utf-16be BOM either.
  const nearBe = Buffer.concat([Buffer.from([0xfe, 0x00]), Buffer.from(ascii, 'latin1')]);
  assert.ok(fb2Head(nearBe).length < nearBe.length);
});

test('fb2Head keeps the marker bytes in the clipped result', () => {
  const buf = Buffer.from('AA<description>m</description>BB', 'latin1');
  const head = fb2Head(buf);
  assert.equal(head.toString('latin1'), 'AA<description>m</description>', 'includes the closing tag, excludes what follows');
});

test('fb2Head clips even when the marker is at offset 0', () => {
  const buf = Buffer.from('</description>the rest of the file', 'latin1');
  assert.equal(fb2Head(buf).toString('latin1'), '</description>', 'i === 0 is still a hit, not "not found"');
});

test('fb2Head needs both bytes of a UTF-16 BOM before switching marker encoding', () => {
  const ascii = '<description>x</description>tail';
  // 0x00 0xFE: byte 1 is 0xFE but byte 0 is not 0xFF -> still the ASCII marker.
  const a = Buffer.concat([Buffer.from([0x00, 0xfe]), Buffer.from(ascii, 'latin1')]);
  assert.ok(fb2Head(a).length < a.length, 'clipped via the latin1 marker');
  const b = Buffer.concat([Buffer.from([0x00, 0xff]), Buffer.from(ascii, 'latin1')]);
  assert.ok(fb2Head(b).length < b.length);
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

test('fb2Cover matches an image content-type case-insensitively', () => {
  const doc = fb2Doc(`<binary id="x" content-type="IMAGE/JPEG">${B64(JPEG)}</binary>`);
  const c = fb2Cover(doc);
  assert.ok(c, 'IMAGE/JPEG still counts as an image');
  assert.equal(c.mime, 'image/jpeg', 'lower-cased while reading the tag');
});

test('fb2Cover reads content-type and id with surrounding spaces and single quotes', () => {
  const doc = fb2Doc(`<binary  id = 'the-cover'  content-type = "application/x" >${B64(PNG)}</binary>`);
  const c = fb2Cover(doc);
  assert.ok(c, 'id matched despite spaces/quotes; "cover" in the id wins');
});

test('fb2Cover stops scanning a binary with no closing > or no </binary', () => {
  assert.equal(fb2Cover(Buffer.from('<binary id="c" content-type="image/png"', 'latin1')), null, 'no closing >');
  assert.equal(
    fb2Cover(Buffer.from(`<binary id="c" content-type="image/png">${B64(PNG)}`, 'latin1')),
    null,
    'no </binary',
  );
});

test('fb2Cover walks past a rejected binary to a later valid one', () => {
  const doc = fb2Doc(
    `<binary id="tiny" content-type="image/png">${B64(Buffer.alloc(8, 1))}</binary>` +
      `<binary id="real" content-type="image/jpeg">${B64(JPEG)}</binary>`,
  );
  const c = fb2Cover(doc);
  assert.ok(c?.data.equals(JPEG), 'skipped the too-small first binary');
});

test('fb2Cover slices the base64 between > and </binary exactly', () => {
  // A one-byte shift either way corrupts the base64 and the image no longer sniffs.
  const doc = fb2Doc(`<binary id="c" content-type="image/png">${B64(PNG)}</binary>`);
  const c = fb2Cover(doc);
  assert.ok(c?.data.equals(PNG), 'decoded bytes are exactly the original image');
});

test('fb2Cover scans a binary that is the first bytes of the buffer', () => {
  const only = Buffer.from(
    `<binary id="cover" content-type="image/png">${B64(PNG)}</binary>`,
    'latin1',
  );
  assert.ok(fb2Cover(only)?.data.equals(PNG), 'the loop starts even when "<binary" is at index 0');
});

test('fb2Cover needs the content-type regex to tolerate spaces around "="', () => {
  // id has no "cover", so the binary is used only if the mime regex matches.
  const doc = fb2Doc(`<binary id="pic" content-type = "image/png">${B64(PNG)}</binary>`);
  assert.ok(fb2Cover(doc)?.data.equals(PNG));
});

test('fb2Cover survives a cover-id binary that has no content-type attribute', () => {
  const doc = fb2Doc(`<binary id="the-cover">${B64(PNG)}</binary>`);
  assert.ok(fb2Cover(doc)?.data.equals(PNG), 'the optional-chaining on a missing match must not throw');
});

test('fb2Cover does not use a non-image, non-cover binary even with image bytes', () => {
  const doc = fb2Doc(`<binary id="plain" content-type="text/plain">${B64(JPEG)}</binary>`);
  assert.equal(fb2Cover(doc), null);
});

test('fb2Cover handles an image binary that has no id attribute', () => {
  const doc = fb2Doc(`<binary content-type="image/png">${B64(PNG)}</binary>`);
  assert.ok(fb2Cover(doc)?.data.equals(PNG), 'the id regex simply not matching must not throw');
});

test('fb2Cover accepts a payload of exactly 33 bytes but not 32', () => {
  const jpeg33 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(30)]);
  const jpeg32 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(29)]);
  assert.ok(fb2Cover(fb2Doc(`<binary id="c" content-type="image/jpeg">${B64(jpeg33)}</binary>`))?.data.length === 33);
  assert.equal(fb2Cover(fb2Doc(`<binary id="c" content-type="image/jpeg">${B64(jpeg32)}</binary>`)), null, '32 bytes is rejected');
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
  // A nameless sequence must be skipped *without* aborting the parse: the lang
  // that follows it still has to be read.
  const m = parseFb2(FB2(`<book-title>X</book-title><sequence number="2"/><lang>fr</lang>`));
  assert.equal(m.series, null);
  assert.equal(m.lang, 'fr', 'parsing continued past the nameless sequence');
});

test('parseFb2 only treats title-info/sequence as a series marker', () => {
  // Another element carrying a name= attribute must not become the series.
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>` +
      `<book-title>X</book-title><custom-info name="not-a-series"/></title-info></description></FictionBook>`,
    'utf8',
  );
  assert.equal(parseFb2(buf).series, null);
});

test('parseFb2 resolves a #-reference cover from either href attribute', () => {
  const withL = (attr: string) =>
    Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>` +
        `<FictionBook xmlns:l="http://www.w3.org/1999/xlink" xmlns:xlink="http://www.w3.org/1999/xlink">` +
        `<description><title-info><book-title>X</book-title>` +
        `<coverpage><image ${attr}/></coverpage></title-info></description>` +
        `<binary id="pic" content-type="image/png">${B64(PNG)}</binary>` +
        `<binary id="jp" content-type="image/jpeg">${B64(JPEG)}</binary></FictionBook>`,
      'latin1',
    );
  assert.ok(parseFb2(withL('l:href="#jp"')).coverData?.equals(JPEG), 'l:href');
  assert.ok(parseFb2(withL('xlink:href="#jp"')).coverData?.equals(JPEG), 'xlink:href');
  // A non-# href is not a binary reference, so it falls back to the first image.
  assert.ok(parseFb2(withL('l:href="external.png"')).coverData?.equals(PNG), 'first image when href is external');
});

test('parseFb2 sets a cover id only from an href that starts with #', () => {
  const mk = (href: string) =>
    Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>` +
        `<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>X</book-title>` +
        `<coverpage><image l:href="${href}"/></coverpage></title-info></description>` +
        `<binary id="pic" content-type="image/png">${B64(PNG)}</binary>` +
        `<binary id="jp" content-type="image/jpeg">${B64(JPEG)}</binary></FictionBook>`,
      'latin1',
    );
  assert.ok(parseFb2(mk('#jp')).coverData?.equals(JPEG), '#jp -> the jp binary');
  // "xjp" has no '#'; slice(1) would be "jp" and wrongly select the jpeg.
  assert.ok(parseFb2(mk('xjp')).coverData?.equals(PNG), 'no # -> no coverId -> first image');
});

test('parseFb2 leaves coverData/coverMime untouched when the payload is too small', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
      `</title-info></description><binary id="c" content-type="image/png">${B64(Buffer.alloc(10, 1))}</binary></FictionBook>`,
    'latin1',
  );
  const m = parseFb2(buf);
  assert.equal(m.coverData, null);
  assert.equal(m.coverMime, undefined, 'no mime is invented for a rejected payload');
});

test('parseFb2 never stores a non-image buffer as the cover', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
      `</title-info></description><binary id="c" content-type="image/png">${B64(Buffer.alloc(80, 7))}</binary></FictionBook>`,
    'latin1',
  );
  assert.equal(parseFb2(buf).coverData, null, '80 bytes of non-image data is still not a cover');
});

test('parseFb2 matches the cover binary id case-insensitively', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>X</book-title>` +
      `<coverpage><image l:href="#COVER"/></coverpage></title-info></description>` +
      `<binary id="cover" content-type="image/jpeg">${B64(JPEG)}</binary></FictionBook>`,
    'latin1',
  );
  assert.ok(parseFb2(buf).coverData?.equals(JPEG), '#COVER matched binary id "cover"');
});

test('parseFb2 sniffs the cover mime when the binary content-type is not an image type', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>X</book-title>` +
      `<coverpage><image l:href="#c"/></coverpage></title-info></description>` +
      `<binary id="c" content-type="application/octet-stream">${B64(PNG)}</binary></FictionBook>`,
    'latin1',
  );
  const m = parseFb2(buf);
  assert.ok(m.coverData?.equals(PNG));
  assert.equal(m.coverMime, 'image/png', 'mime came from sniffing the bytes');
});

test('parseFb2 falls back through the image-mime and cover-id rules to the first binary', () => {
  const mk = (bins: string) =>
    Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
        `</title-info></description>${bins}</FictionBook>`,
      'latin1',
    );
  // no coverpage ref, no image/* type, no "cover" id: first decodable binary wins
  assert.ok(
    parseFb2(mk(`<binary id="a" content-type="text/plain">${B64(PNG)}</binary>`)).coverData?.equals(PNG),
    'first binary is used as a last resort',
  );
  // an image/* typed binary is preferred over an earlier non-image one
  assert.ok(
    parseFb2(
      mk(
        `<binary id="a" content-type="text/plain">${B64(Buffer.alloc(64, 5))}</binary>` +
          `<binary id="b" content-type="image/jpeg">${B64(JPEG)}</binary>`,
      ),
    ).coverData?.equals(JPEG),
  );
});

test('parseFb2 rejects a cover payload of 32 bytes or fewer', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
      `</title-info></description><binary id="c" content-type="image/png">${B64(Buffer.alloc(32, 0x89))}</binary></FictionBook>`,
    'latin1',
  );
  assert.equal(parseFb2(buf).coverData, null, '<= 32 bytes is treated as junk');
});

test('parseFb2 keeps first/last name state separate across multiple authors', () => {
  const m = parseFb2(
    FB2(
      `<book-title>X</book-title>` +
        `<author><first-name>Anna</first-name><last-name>Adams</last-name></author>` +
        `<author><first-name>Bob</first-name><last-name>Brown</last-name></author>`,
    ),
  );
  assert.deepEqual(m.authors, ['Adams Anna', 'Brown Bob'], 'the second author is not "Adams Anna Brown Bob"');
});

test('parseFb2 resets genre accumulation between genre elements', () => {
  const m = parseFb2(FB2(`<book-title>X</book-title><genre>Alpha</genre><genre>Beta</genre>`));
  assert.deepEqual(m.genres, ['alpha', 'beta'], 'not ["alpha", "alphabeta"]');
});

test('parseFb2 ignores captured text once </description> has been seen', () => {
  // A stray <book-title> after the description must not append to the title.
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>` +
      `<book-title>Real</book-title></title-info></description>` +
      `<body><title-info><book-title>LATER</book-title></title-info></body></FictionBook>`,
    'utf8',
  );
  assert.equal(parseFb2(buf).title, 'Real');
});

test('parseFb2 reorders a multi-token author name last-token-first', () => {
  assert.deepEqual(
    parseFb2(FB2(`<book-title>X</book-title><author><first-name>Hans Christian</first-name><last-name>Andersen</last-name></author>`)).authors,
    ['Andersen Hans Christian'],
  );
});

test('parseFb2 returns an empty title (not a placeholder) when there is none', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>` +
      `<lang>en</lang></title-info></description></FictionBook>`,
    'utf8',
  );
  assert.equal(parseFb2(buf).title, '');
});

test('parseFb2 needs the image-mime prefix at the start, not just anywhere', () => {
  // "notimage/png" contains "image/" but is not an image type: the real
  // image/jpeg binary that follows must be the one chosen.
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
      `</title-info></description>` +
      `<binary id="a" content-type="notimage/png">${B64(Buffer.alloc(64, 3))}</binary>` +
      `<binary id="b" content-type="image/jpeg">${B64(JPEG)}</binary></FictionBook>`,
    'latin1',
  );
  assert.ok(parseFb2(buf).coverData?.equals(JPEG));
});

test('parseFb2 ignores a <binary> with no id', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
      `</title-info></description><binary content-type="image/png">${B64(PNG)}</binary></FictionBook>`,
    'latin1',
  );
  assert.equal(parseFb2(buf).coverData, null, 'an id-less binary is never collected');
});

test('parseFb2 leaves lang and annotation empty when the elements are absent', () => {
  const m = parseFb2(FB2(`<book-title>Solo</book-title>`));
  assert.equal(m.lang, '');
  assert.equal(m.annotation, '');
});

test('parseFb2 only captures text for elements it recognises', () => {
  // <year> lives in <publish-info>, matches none of the capture rules, and must
  // not leak into the annotation.
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>` +
      `<book-title>X</book-title></title-info>` +
      `<publish-info><year>2001</year><book-name>Anthology</book-name></publish-info>` +
      `</description></FictionBook>`,
    'utf8',
  );
  assert.equal(parseFb2(buf).annotation, '', 'publish-info text stays out of the annotation');
});

test('parseFb2 only reads a #cover reference from a coverpage/image element', () => {
  // A body <a l:href="#second"> must NOT become the cover id; with no coverpage
  // the cover falls to the first image binary ("first"), not the linked one.
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info>` +
      `<book-title>X</book-title></title-info></description>` +
      `<body><p><a l:href="#second">link</a></p></body>` +
      `<binary id="first" content-type="image/png">${B64(PNG)}</binary>` +
      `<binary id="second" content-type="image/jpeg">${B64(JPEG)}</binary></FictionBook>`,
    'latin1',
  );
  assert.ok(parseFb2(buf).coverData?.equals(PNG), 'first binary wins; the body link was ignored');
});

test('parseFb2 uses lenient (non-strict) XML parsing', () => {
  // A bare "&" is invalid XML; a strict parser would abort at it and never
  // reach <lang>. The lenient parser keeps going.
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>` +
      `<book-title>Tom & Jerry</book-title><lang>en</lang></title-info></description></FictionBook>`,
    'utf8',
  );
  assert.equal(parseFb2(buf).lang, 'en', 'parsing continued past the bare ampersand');
});

test('parseFb2 leaves a single-token author untouched and keeps a comma author as written', () => {
  assert.deepEqual(parseFb2(FB2(`<book-title>X</book-title><author><last-name>Voltaire</last-name></author>`)).authors, ['Voltaire']);
  assert.deepEqual(
    parseFb2(FB2(`<book-title>X</book-title><author><first-name>Le Guin, Ursula</first-name></author>`)).authors,
    ['Le Guin, Ursula'],
  );
});

test('parseFb2 collapses annotation whitespace and separates adjacent chunks', () => {
  assert.equal(
    parseFb2(FB2(`<book-title>X</book-title><annotation><p>one</p>  <p>two</p></annotation>`)).annotation,
    'one two',
  );
  // Adjacent tags with no whitespace between them: the parser must still insert
  // a separator, otherwise this reads "onetwo".
  assert.equal(
    parseFb2(FB2(`<book-title>X</book-title><annotation><p>one</p><p>two</p></annotation>`)).annotation,
    'one two',
  );
});

test('parseFb2 trims the genre value, not just lower-cases it', () => {
  assert.deepEqual(parseFb2(FB2(`<book-title>X</book-title><genre>  Space Opera  </genre>`)).genres, ['space opera']);
});

test('parseFb2 aborts cleanly (caught) on an empty <genre></genre>', () => {
  // meta._genre is undefined, so `name === "genre" && meta._genre` must be false;
  // an OR mutant would call undefined.trim() and throw, losing the lang below.
  const m = parseFb2(FB2(`<book-title>X</book-title><genre></genre><lang>de</lang>`));
  assert.equal(m.lang, 'de');
  assert.deepEqual(m.genres, []);
});

test('parseFb2 does not push an author with no name parts', () => {
  const m = parseFb2(FB2(`<book-title>X</book-title><author><home-page>x</home-page></author>`));
  assert.deepEqual(m.authors, []);
});

test('parseFb2 trims each author name part before joining', () => {
  const m = parseFb2(
    FB2(`<book-title>X</book-title><author><first-name> John </first-name><last-name> Doe </last-name></author>`),
  );
  assert.deepEqual(m.authors, ['Doe John'], 'no doubled or leading spaces');
});

test('parseFb2 splits an author name on runs of whitespace', () => {
  const m = parseFb2(
    FB2(`<book-title>X</book-title><author><first-name>Hans  Christian</first-name><last-name>Andersen</last-name></author>`),
  );
  assert.deepEqual(m.authors, ['Andersen Hans Christian'], 'the double space collapses');
});

test('parseFb2 trims the date element text', () => {
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>` +
      `<book-title>X</book-title></title-info><document-info><date>  2005-05-05  </date></document-info>` +
      `</description></FictionBook>`,
    'utf8',
  );
  assert.equal(parseFb2(buf).docdate, '2005-05-05');
});

test('parseFb2 keeps the declared image content-type over the sniffed one', () => {
  // content-type lies (says png) but the bytes are jpeg: the declared type wins.
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>X</book-title>` +
      `<coverpage><image l:href="#c"/></coverpage></title-info></description>` +
      `<binary id="c" content-type="image/png">${B64(JPEG)}</binary></FictionBook>`,
    'latin1',
  );
  assert.equal(parseFb2(buf).coverMime, 'image/png', 'declared image/* type is trusted');
});

test('parseFb2 finds the cover only via the /cover/ id rule when needed', () => {
  // first binary: junk, non-image, non-cover id. second: non-image type but a
  // "cover" id and real image bytes. Only rule 3 (id match) can pick it.
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
      `</title-info></description>` +
      `<binary id="junk" content-type="text/plain">${B64(Buffer.alloc(64, 9))}</binary>` +
      `<binary id="the-cover" content-type="application/octet-stream">${B64(JPEG)}</binary></FictionBook>`,
    'latin1',
  );
  assert.ok(parseFb2(buf).coverData?.equals(JPEG));
});

test('parseFb2 concatenates multi-line base64 in a binary without a separator', () => {
  const wrapped = B64(PNG).replace(/(.{8})/g, '$1\n');
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
      `</title-info></description><binary id="c" content-type="image/png">\n${wrapped}\n</binary></FictionBook>`,
    'latin1',
  );
  assert.ok(parseFb2(buf).coverData?.equals(PNG), 'newlines between b64 lines are stripped, not turned into junk');
});

test('parseFb2 rejects a decoded cover of exactly 32 bytes', () => {
  const png32 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(28)]);
  const buf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>X</book-title>` +
      `</title-info></description><binary id="c" content-type="image/png">${B64(png32)}</binary></FictionBook>`,
    'latin1',
  );
  assert.equal(parseFb2(buf).coverData, null);
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
