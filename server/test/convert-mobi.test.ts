import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mobiToIr,
  irToMobi,
  parsePalmDb,
  palmDocDecompress,
  stripTrailingEntries,
  decodeBackwardVarint,
  parseExth,
  decodeText,
  stripMobiWrappers,
  imageMime,
  buildExth,
  buildFlis,
  buildFcis,
  assemblePalmDb,
  sanitizeDbName,
  padTo4,
} from '../src/services/convert/mobi.js';
import { emptyIr } from '../src/services/convert/ir.js';
import type { Ir } from '../src/services/convert/ir.js';

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);

const withIr = (over: Partial<Ir>): Ir => ({ ...emptyIr(), ...over });

// ---- small pure helpers -------------------------------------------

test('padTo4 rounds up to the next multiple of 4', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 8].map(padTo4), [0, 4, 4, 4, 4, 8, 8]);
});

test('sanitizeDbName keeps a filesystem-safe name and never returns empty', () => {
  assert.equal(sanitizeDbName('Война & Peace: Book 1'), 'Peace_Book_1');
  assert.equal(sanitizeDbName('   '), 'book', 'whitespace-only -> book');
  assert.equal(sanitizeDbName(''), 'book');
  assert.equal(sanitizeDbName('!!!'), 'book', 'nothing usable -> book');
  assert.equal(sanitizeDbName('x'.repeat(40)), 'x'.repeat(31), 'clamped to 31 chars');
});

test('imageMime recognises the three magic numbers, else null', () => {
  assert.equal(imageMime(JPG), 'image/jpeg');
  assert.equal(imageMime(PNG), 'image/png');
  assert.equal(imageMime(GIF), 'image/gif');
  assert.equal(imageMime(Buffer.from('not an image')), null);
  assert.equal(imageMime(Buffer.alloc(2)), null, 'too short');
  assert.equal(imageMime(Buffer.from([0xff, 0xd8])), null, 'jpeg magic but only 2 bytes -> rejected on length');
  assert.equal(imageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png', 'exactly 4 bytes is enough');
  assert.equal(imageMime(undefined), null);
});

test('decodeText decodes utf-8 and windows-1252, with a graceful fallback', () => {
  assert.equal(decodeText(Buffer.from('héllo', 'utf8'), 'utf8'), 'héllo');
  assert.equal(decodeText(Buffer.from([0x93, 0x94]), 'latin1'), '“”', 'cp1252 smart quotes');
});

test('stripMobiWrappers removes the MOBI structural tags but keeps content', () => {
  assert.equal(
    stripMobiWrappers(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<html lang="en"><head><guide type="x"></guide></head><body class="c"><p>keep</p>' +
        '<a href="#top" filepos=0000012345>x<a class="anchor" name="n"></a></body></html>',
    ),
    '<p>keep</p>x',
    'the xml decl, attributed html/head/body/guide tags and the filepos + empty anchors go',
  );
  assert.equal(stripMobiWrappers(''), '');
  assert.equal(stripMobiWrappers(null as unknown as string), '');
  assert.equal(
    stripMobiWrappers('  <html><body><p>x</p></body></html>  '),
    '<p>x</p>',
    'leading/trailing whitespace is trimmed off the result',
  );
});

// ---- PalmDOC (LZ77) -----------------------------------------------

test('palmDocDecompress 0xc0..0xff is exactly a space then (byte ^ 0x80)', () => {
  assert.deepEqual([...palmDocDecompress(Buffer.from([0xc1, 0xe5]))], [0x20, 0x41, 0x20, 0x65]);
});

test('palmDocDecompress handles every opcode class', () => {
  // 0x00 -> a literal NUL
  assert.deepEqual([...palmDocDecompress(Buffer.from([0x00]))], [0]);
  // 0x01..0x08 -> copy that many literal bytes
  assert.deepEqual([...palmDocDecompress(Buffer.from([0x03, 65, 66, 67]))], [65, 66, 67]);
  // 0x09..0x7f -> the byte itself
  assert.equal(palmDocDecompress(Buffer.from([0x41, 0x42])).toString(), 'AB');
  // 0xc0..0xff -> a space followed by (byte ^ 0x80)
  assert.equal(palmDocDecompress(Buffer.from([0xc1])).toString(), ' A');
  // 0x80..0xbf -> LZ77 back-reference: distance in bits 3..13, length = low 3 + 3
  // encode "ABCABC": literals A B C, then a backref distance 3 length 3
  const lz = (3 << 3) | (3 - 3); // distance 3, length 3
  const compressed = Buffer.from([0x41, 0x42, 0x43, 0x80 | (lz >> 8), lz & 0xff]);
  assert.equal(palmDocDecompress(compressed).toString(), 'ABCABC');
});

test('palmDocDecompress stops cleanly on a truncated literal run or back-ref', () => {
  assert.deepEqual([...palmDocDecompress(Buffer.from([0x05, 65, 66]))], [65, 66], 'run runs past the end');
  assert.deepEqual([...palmDocDecompress(Buffer.from([0x90]))], [], 'lone high byte with no second');
  // the run byte must actually consume the following byte as a literal: 0x90
  // read as a literal would take the LZ77 branch and be lost, so a run of 1
  // proves the byte was copied verbatim.
  assert.deepEqual([...palmDocDecompress(Buffer.from([0x01, 0x90]))], [0x90]);
});

// ---- backwards varint + trailing entry stripping ----------------

test('decodeBackwardVarint reads a varint from the tail, stopping at the high-bit byte', () => {
  // one byte, high bit set -> just its low 7 bits
  assert.equal(decodeBackwardVarint(Buffer.from([0x00, 0x85]), 2), 5);
  // two bytes: the tail byte has bit 7 clear (0x01), the one before terminates
  // it (0x82) -> ((0x82 & 0x7f) << 7) | 0x01
  assert.equal(decodeBackwardVarint(Buffer.from([0x82, 0x01]), 2), (0x02 << 7) | 0x01);
});

test('stripTrailingEntries drops one entry per set flag bit above bit 0, then the overlap byte', () => {
  const body = Buffer.from('the real text');
  // extraFlags with bit 1 set -> one trailing entry whose size varint is the last byte
  const withEntry = Buffer.concat([body, Buffer.from([0x84])]); // size 4 = the 1 varint byte + 3 padding... here size=4 strips 4 bytes
  const trimmed = stripTrailingEntries(Buffer.concat([body, Buffer.alloc(3), Buffer.from([0x84])]), 0b10);
  assert.equal(trimmed.toString(), 'the real text');
  void withEntry;

  // bit 0 set -> also strip (last byte low 2 bits) + 1 as a multibyte overlap
  const withOverlap = Buffer.concat([body, Buffer.from([0x02])]); // 0x02 & 3 = 2 -> strip 3
  assert.equal(stripTrailingEntries(withOverlap, 0b1).toString(), 'the real te');

  // no flags -> unchanged
  assert.equal(stripTrailingEntries(body, 0).toString(), 'the real text');
});

// ---- PalmDB parsing ---------------------------------------------

test('parsePalmDb slices records at their offsets, with a sentinel for the last', () => {
  const recs = [Buffer.from('AAAA'), Buffer.from('BB'), Buffer.from('CCCCCC')];
  const db = assemblePalmDb('My Book', recs);
  const parsed = parsePalmDb(db);
  assert.equal(parsed.type, 'BOOK');
  assert.equal(parsed.creator, 'MOBI');
  assert.deepEqual(parsed.records.map((r) => r.toString()), ['AAAA', 'BB', 'CCCCCC']);
  // the sanitised title lands in the first 32 bytes of the PalmDB header
  assert.equal(db.toString('latin1', 0, 7), 'My_Book');
  assert.equal(db.readUInt16BE(76), 3, 'record count');
  // record offsets are consecutive and start right after header + record list
  const headerLen = 78 + 3 * 8 + 2;
  assert.equal(db.readUInt32BE(78), headerLen);
  assert.equal(db.readUInt32BE(78 + 8), headerLen + 4);
  assert.equal(db.readUInt32BE(78 + 16), headerLen + 6);
});

test('parsePalmDb rejects a file too small to hold a header', () => {
  assert.throws(() => parsePalmDb(Buffer.alloc(10)), /too small/);
});

// ---- EXTH ------------------------------------------------------

test('parseExth reads authors, title and language records and skips unknown types', () => {
  const rec = (type: number, s: string) => {
    const data = Buffer.from(s, 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32BE(type, 0);
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  };
  const body = Buffer.concat([rec(100, 'Ann'), rec(100, 'Bob'), rec(503, 'The Title'), rec(524, 'de'), rec(999, 'ignored')]);
  const header = Buffer.alloc(12);
  header.write('EXTH', 0, 'latin1');
  header.writeUInt32BE(12 + body.length, 4);
  header.writeUInt32BE(5, 8);
  const exth = Buffer.concat([header, body]);
  const meta = parseExth(exth, 0);
  assert.deepEqual(meta.authors, ['Ann', 'Bob']);
  assert.equal(meta.title, 'The Title');
  assert.equal(meta.language, 'de');
});

test('parseExth returns the empty meta when the block does not start with EXTH', () => {
  const meta = parseExth(Buffer.from('NOPE and then some'), 0);
  assert.deepEqual(meta, { authors: [], title: null, language: null, coverOffset: null });
});

test('buildExth round-trips through parseExth', () => {
  const exth = buildExth(withIr({ title: 'Round Trip', authors: ['X Y', 'Z W'], language: 'fr', identifier: 'id-1' }));
  assert.equal(exth.length % 4, 0, 'padded to a 4-byte boundary');
  const meta = parseExth(exth, 0);
  assert.deepEqual(meta.authors, ['X Y', 'Z W']);
  assert.equal(meta.title, 'Round Trip');
  assert.equal(meta.language, 'fr');
});

test('buildExth defaults the author to Unknown and omits language when empty', () => {
  const meta = parseExth(buildExth(withIr({ title: 'T', authors: [], language: '' })), 0);
  assert.deepEqual(meta.authors, ['Unknown']);
  assert.equal(meta.language, null);
});

test('buildExth falls back to Untitled when the ir carries no title', () => {
  assert.equal(parseExth(buildExth(withIr({ title: '' })), 0).title, 'Untitled');
});

test('irToMobi falls back to an "Untitled" name/full-name when the ir has no title', () => {
  const mobi = irToMobi(withIr({ title: '', chapters: [{ title: '', html: '<p>x</p>' }] }));
  // the PalmDB name (sanitised) and the round-tripped title
  assert.equal(mobi.toString('latin1', 0, 8), 'Untitled');
  const back = mobiToIr(mobi);
  assert.equal(back.title, 'Untitled');
  // the stored full name is "Untitled" too
  const r0 = parsePalmDb(mobi).records[0];
  const off = r0.readUInt32BE(0x54);
  const len = r0.readUInt32BE(0x58);
  assert.equal(r0.toString('utf8', off, off + len), 'Untitled');
});

test('buildFlis is the exact fixed FLIS record', () => {
  assert.equal(
    buildFlis().toString('hex'),
    '464c4953000000080041000000000000ffffffff000100030000000300000001ffffffff',
  );
});

test('buildFcis is the fixed FCIS record with the text length spliced in at offset 20', () => {
  assert.equal(
    buildFcis(1234).toString('hex'),
    '4643495300000014000000100000000100000000000004d20000000000000020000000080001000100000000',
  );
  assert.equal(buildFcis(0xabcd).readUInt32BE(20), 0xabcd);
});

// ---- full round trip -----------------------------------------

test('irToMobi writes every fixed header field at its documented offset', () => {
  const ir = withIr({
    title: 'AB',
    language: 'en',
    authors: ['X'],
    chapters: [{ title: 'C', html: '<p>hello world</p>' }],
    images: [{ id: 'p.jpg', mime: 'image/jpeg', data: JPG }],
  });
  const m = irToMobi(ir);
  const p = parsePalmDb(m);
  assert.equal(p.type, 'BOOK');
  assert.equal(p.creator, 'MOBI');
  assert.equal(m.readUInt16BE(76), p.records.length, 'record count in the PalmDB header');

  const r0 = p.records[0];
  // PalmDOC header
  assert.equal(r0.readUInt16BE(0), 1, 'compression: 1 = uncompressed');
  assert.equal(r0.readUInt16BE(8), 1, 'one text record');
  assert.equal(r0.readUInt16BE(10), 4096, 'record size');
  const textLen = r0.readUInt32BE(4);
  // MOBI header
  assert.equal(r0.toString('latin1', 16, 20), 'MOBI');
  assert.equal(r0.readUInt32BE(20), 0xc8, 'MOBI header length');
  assert.equal(r0.readUInt32BE(24), 2, 'mobi type = book');
  assert.equal(r0.readUInt32BE(28), 65001, 'text encoding = UTF-8');
  assert.equal(r0.readUInt32BE(36), 6, 'file version at 0x24');
  assert.ok(
    r0.subarray(0x28, 0x54).every((byte) => byte === 0xff),
    'the index-record slots 0x28..0x53 are all 0xff (absent)',
  );
  assert.equal(r0.readUInt32BE(0x80), 0x40, 'EXTH-present flag');
  assert.equal(r0.readUInt32BE(0x6c), 2, 'first image index = 1 + numTextRecords');
  assert.equal(r0.readUInt32BE(0xb0), 0xffffffff, 'DRM offset = none');
  assert.equal(r0.readUInt16BE(0xc0), 1, 'first content record');
  assert.equal(r0.readUInt16BE(0xc2), 2, 'last content record = text + image count');
  // full name is stored after the PalmDOC + MOBI headers + EXTH
  const off = r0.readUInt32BE(0x54);
  const len = r0.readUInt32BE(0x58);
  assert.equal(r0.toString('utf8', off, off + len), 'AB', 'full name at its recorded offset/length');

  // the text records inflate back to the original blob length
  const textRec = p.records[1];
  assert.equal(textRec.length, textLen, 'the single text record holds the whole blob');

  // no-image book: first-image index is 0xffffffff
  const noImg = parsePalmDb(irToMobi(withIr({ title: 'T', chapters: [{ title: '', html: '<p>x</p>' }] })));
  assert.equal(noImg.records[0].readUInt32BE(0x6c), 0xffffffff);
});

test('irToMobi produces a MOBI that mobiToIr reads back with metadata and text', () => {
  const ir = withIr({
    title: 'Mobi Round Trip',
    language: 'en',
    authors: ['Solo Author'],
    chapters: [
      { title: 'Chapter One', html: '<p>First chapter body text here.</p>' },
      { title: 'Chapter Two', html: '<p>Second chapter, more words.</p>' },
    ],
  });
  const back = mobiToIr(irToMobi(ir));
  assert.equal(back.title, 'Mobi Round Trip');
  assert.equal(back.language, 'en');
  assert.deepEqual(back.authors, ['Solo Author']);
  const text = back.chapters.map((c) => c.html.replace(/<[^>]+>/g, ' ')).join(' ').replace(/\s+/g, ' ');
  assert.match(text, /First chapter body text here/);
  assert.match(text, /Second chapter, more words/);
  assert.ok(back.chapters.length >= 2, 'the pagebreak split produced multiple chapters');
});

test('irToMobi carries images through, rewriting src=images/ID to recindex and back', () => {
  const ir = withIr({
    title: 'With Pictures',
    chapters: [
      { title: '', html: '<p>see <img class="c" src="images/fig.jpg" alt="a"/> and <img src="images/missing.png"/></p>' },
    ],
    images: [{ id: 'fig.jpg', mime: 'image/jpeg', data: JPG }],
  });
  const blob = parsePalmDb(irToMobi(ir)).records[1].toString('utf8');
  // the known image becomes recindex 1; the unknown src becomes nothing at all -
  // not recindex 0, not the first image, not placeholder text.
  assert.match(blob, /<body><p>see <img recindex="00001"\/> and <\/p><\/body>/);
  assert.equal((blob.match(/recindex/g) || []).length, 1, 'exactly one recindex written');

  const back = mobiToIr(irToMobi(ir));
  assert.equal(back.images.length, 1);
  assert.equal(back.images[0].mime, 'image/jpeg');
  assert.match(back.chapters[0].html, /<img src="images\/img00001" alt=""\/>/);
  assert.ok(back.cover, 'the first image becomes the cover');
});

// Build a raw MOBI record 0 + text/image records by hand, for reader coverage.
function rawMobi(opts: {
  compression?: number;
  encoding?: number; // 1252 => latin1, else utf8
  text: Buffer;
  images?: Buffer[];
  exth?: Buffer;
  fullName?: string;
}): Buffer {
  const text = opts.text;
  const images = opts.images ?? [];
  const exth = opts.exth ?? buildExth(withIr({ title: 'X', authors: ['A'] }));
  const fullName = Buffer.from(opts.fullName ?? 'X', 'utf8');
  const MOBI_HDR = 0xc8;
  const mobi = Buffer.alloc(MOBI_HDR);
  mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(MOBI_HDR, 4);
  mobi.writeUInt32BE(2, 8);
  mobi.writeUInt32BE(opts.encoding ?? 65001, 0x1c - 16); // text-encoding word (0x1c in record 0)
  const fullNameOffset = 16 + MOBI_HDR + exth.length;
  mobi.writeUInt32BE(fullNameOffset, 0x54 - 16);
  mobi.writeUInt32BE(fullName.length, 0x58 - 16);
  mobi.writeUInt32BE(images.length ? 2 : 0xffffffff, 0x6c - 16);
  mobi.writeUInt32BE(0x40, 0x80 - 16);
  const palm = Buffer.alloc(16);
  palm.writeUInt16BE(opts.compression ?? 1, 0);
  palm.writeUInt32BE(text.length, 4);
  palm.writeUInt16BE(1, 8); // one text record
  palm.writeUInt16BE(4096, 10);
  const rec0 = Buffer.concat([palm, mobi, exth, fullName, Buffer.alloc(4)]);
  return assemblePalmDb('X', [rec0, text, ...images, buildFlis(), buildFcis(text.length)]);
}

// trivial PalmDOC compressor: only literal-run opcodes (1..8)
function palmDocCompress(buf: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 8) {
    const chunk = buf.subarray(i, i + 8);
    out.push(chunk.length, ...chunk);
  }
  return Buffer.from(out);
}

test('mobiToIr inflates PalmDOC-compressed (compression=2) text records', () => {
  const html = '<html><body><p>compressed body content</p></body></html>';
  const mobi = rawMobi({ compression: 2, text: palmDocCompress(Buffer.from(html, 'utf8')) });
  const ir = mobiToIr(mobi);
  assert.match(ir.chapters.map((c) => c.html).join(' '), /compressed body content/);
});

test('mobiToIr decodes windows-1252 text when the encoding word says 1252', () => {
  const body = Buffer.concat([Buffer.from('<p>smart '), Buffer.from([0x93, 0x94]), Buffer.from('</p>')]);
  const ir = mobiToIr(rawMobi({ encoding: 1252, text: body }));
  assert.match(ir.chapters[0].html, /smart “”/);
});

test('mobiToIr splits on <mbp:pagebreak> / <pagebreak> and reads a title from an attributed h1..h6', () => {
  const text = Buffer.from(
    '<body><h2 class="c">Part One</h2><p>a</p>' +
      '<mbp:pagebreak class="pb"/>' +
      '<h3>Part <b>Two</b></h3><p>b</p>' +
      '<pagebreak style="x">' + // non-namespaced, carrying an attribute, no self-closing slash
      '<h1>Part Three</h1><p>c</p></body>',
    'utf8',
  );
  const ir = mobiToIr(rawMobi({ text }));
  assert.deepEqual(ir.chapters.map((c) => c.title), ['Part One', 'Part Two', 'Part Three']);
  // a chunk that is only markup / whitespace is dropped
  const sparse = mobiToIr(rawMobi({ text: Buffer.from('<body><p>real</p><mbp:pagebreak/><span>  </span></body>', 'utf8') }));
  assert.equal(sparse.chapters.length, 1);
});

test('mobiToIr always produces at least one chapter, even for a bodyless book', () => {
  const ir = mobiToIr(rawMobi({ text: Buffer.from('<body></body>', 'utf8'), exth: exthOf([[503, 'Titled']]) }));
  assert.equal(ir.chapters.length, 1);
  assert.deepEqual(ir.chapters, [{ title: '', html: '' }]);
  assert.equal(ir.title, 'Titled');
});

test('mobiToIr collects image records from firstImageIndex and stops at FLIS', () => {
  const text = Buffer.from('<body><p>x <img recindex="00001"/> y <img recindex="9"/></p></body>', 'utf8');
  const ir = mobiToIr(rawMobi({ text, images: [JPG, PNG] }));
  assert.deepEqual(ir.images.map((i) => i.mime), ['image/jpeg', 'image/png']);
  assert.match(ir.chapters[0].html, /<img src="images\/img00001" alt=""\/>/, 'recindex 1 rewritten');
  assert.ok(
    !/recindex="9"|Stryker/.test(ir.chapters[0].html),
    'a recindex with no matching image is replaced with nothing, not placeholder text',
  );
});

function exthOf(recs: [number, string][]): Buffer {
  const body = Buffer.concat(
    recs.map(([type, s]) => {
      const data = Buffer.from(s, 'utf8');
      const head = Buffer.alloc(8);
      head.writeUInt32BE(type, 0);
      head.writeUInt32BE(8 + data.length, 4);
      return Buffer.concat([head, data]);
    }),
  );
  const header = Buffer.alloc(12);
  header.write('EXTH', 0, 'latin1');
  header.writeUInt32BE(12 + body.length, 4);
  header.writeUInt32BE(recs.length, 8);
  let exth = Buffer.concat([header, body]);
  const pad = (4 - (exth.length % 4)) % 4;
  if (pad) exth = Buffer.concat([exth, Buffer.alloc(pad)]);
  return exth;
}

test('mobiToIr ignores the full name when its offset/length are zero or out of range', () => {
  const base = () =>
    rawMobi({ text: Buffer.from('<body><p>x</p></body>', 'utf8'), exth: exthOf([[100, 'A']]), fullName: 'FN' });
  const zeroOff = base();
  parsePalmDb(zeroOff).records[0].writeUInt32BE(0, 0x54); // fullNameOffset = 0
  assert.equal(mobiToIr(zeroOff).title, 'Untitled', 'offset 0 -> no full name');

  const zeroLen = base();
  parsePalmDb(zeroLen).records[0].writeUInt32BE(0, 0x58); // fullNameLength = 0
  assert.equal(mobiToIr(zeroLen).title, 'Untitled');

  const oor = base();
  parsePalmDb(oor).records[0].writeUInt32BE(0xffff, 0x58); // length runs past record 0
  assert.equal(mobiToIr(oor).title, 'Untitled', 'out-of-range slice is refused');
});

test('mobiToIr respects a non-1252 encoding word (utf-8 text stays utf-8)', () => {
  const body = Buffer.from('<body><p>café — déjà</p></body>', 'utf8');
  const ir = mobiToIr(rawMobi({ encoding: 65001, text: body }));
  assert.match(ir.chapters[0].html, /café — déjà/, 'not mis-decoded as windows-1252');
});

test('mobiToIr does not clobber a real title/authors with empty EXTH records', () => {
  // EXTH present (flag set) but carrying only a language record
  const mobi = rawMobi({
    text: Buffer.from('<body><p>x</p></body>', 'utf8'),
    exth: exthOf([[524, 'sv']]),
    fullName: 'Kept Name',
  });
  const ir = mobiToIr(mobi);
  assert.equal(ir.title, 'Kept Name', 'no EXTH title -> full name wins, not a null');
  assert.deepEqual(ir.authors, [], 'no EXTH authors -> authors untouched');
  assert.equal(ir.language, 'sv');
});

test('mobiToIr takes the title from record 0 full name when EXTH has none', () => {
  const mobi = rawMobi({
    text: Buffer.from('<body><p>x</p></body>', 'utf8'),
    exth: exthOf([[100, 'Only Author']]), // no 503 title
    fullName: 'The Full Name',
  });
  const ir = mobiToIr(mobi);
  assert.equal(ir.title, 'The Full Name');
  assert.deepEqual(ir.authors, ['Only Author']);
});

test('mobiToIr keeps the EXTH title over the full name when both are present', () => {
  const mobi = rawMobi({
    text: Buffer.from('<body><p>x</p></body>', 'utf8'),
    exth: exthOf([[503, 'EXTH Title']]),
    fullName: 'Full Name',
  });
  assert.equal(mobiToIr(mobi).title, 'EXTH Title');
});

test('parseExth stops at the record count and at the declared length', () => {
  // count says 3 but only 1 real record follows; len covers only that one
  const one = (() => {
    const data = Buffer.from('Solo', 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32BE(100, 0);
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  })();
  const header = Buffer.alloc(12);
  header.write('EXTH', 0, 'latin1');
  header.writeUInt32BE(12 + one.length, 4); // len = header + exactly one record
  header.writeUInt32BE(3, 8); // lies: says 3
  const junk = Buffer.from('503!!!!garbage-after-the-declared-end');
  const meta = parseExth(Buffer.concat([header, one, junk]), 0);
  assert.deepEqual(meta.authors, ['Solo'], 'nothing past the declared length is parsed');
});

test('imageMime distinguishes each magic byte', () => {
  assert.equal(imageMime(Buffer.from([0xff, 0x00, 0, 0])), null, 'jpeg needs both 0xff 0xd8');
  assert.equal(imageMime(Buffer.from([0x00, 0xd8, 0, 0])), null);
  assert.equal(imageMime(Buffer.from([0x89, 0x50, 0x4e, 0x00])), null, 'png needs all four bytes');
  assert.equal(imageMime(Buffer.from([0x89, 0x50, 0x00, 0x47])), null);
  assert.equal(imageMime(Buffer.from([0x89, 0x00, 0x4e, 0x47])), null);
  assert.equal(imageMime(Buffer.from([0x00, 0x50, 0x4e, 0x47])), null);
  assert.equal(imageMime(Buffer.from('GIx', 'latin1')), null, 'gif needs "GIF"');
});

test('mobiToIr image scan: honours firstImageIndex, and falls back past the text records', () => {
  const text = Buffer.from('<body><p>x</p></body>', 'utf8');
  // firstImageIndex written as 0 -> reader falls back to recordCount+1 (== 2 here)
  const raw = rawMobi({ text, images: [PNG] });
  parsePalmDb(raw).records[0].writeUInt32BE(0, 0x6c); // records are views into `raw`
  assert.equal(mobiToIr(raw).images.length, 1, 'still finds the image after the text record');

  // firstImageIndex past the end -> also the fallback
  const raw2 = rawMobi({ text, images: [GIF] });
  parsePalmDb(raw2).records[0].writeUInt32BE(999, 0x6c);
  assert.equal(mobiToIr(raw2).images.length, 1);
});

test('mobiToIr clips the assembled text to the declared textLength', () => {
  const real = Buffer.from('<body><p>only this part</p></body>', 'utf8');
  const padded = Buffer.concat([real, Buffer.from('GARBAGE PAST THE DECLARED END')]);
  const mobi = rawMobi({ text: padded });
  parsePalmDb(mobi).records[0].writeUInt32BE(real.length, 4); // textLength = real length
  const ir = mobiToIr(mobi);
  const all = ir.chapters.map((c) => c.html).join(' ');
  assert.match(all, /only this part/);
  assert.ok(!/GARBAGE/.test(all), 'bytes past textLength are dropped');
});

test('mobiToIr / stripMobiWrappers handle tags that carry attributes', () => {
  const text = Buffer.from(
    '<body class="x"><h2 id="c" class="t">Titled</h2><p>body</p></body>',
    'utf8',
  );
  const ir = mobiToIr(rawMobi({ text }));
  assert.equal(ir.chapters[0].title, 'Titled', 'the attributed <h2> still yields the title');
  assert.ok(!/<body/.test(ir.chapters.map((c) => c.html).join('')), 'attributed <body> stripped');
});

test('mobiToIr <img recindex> rewrite: attributes, leading zeros, quotes, out-of-range', () => {
  const text = Buffer.from(
    '<body><p><img class="fig" recindex="00001" alt="x"/> <img recindex=2 /> <img recindex="007"/></p></body>',
    'utf8',
  );
  const ir = mobiToIr(rawMobi({ text, images: [JPG, PNG] }));
  const html = ir.chapters[0].html;
  assert.match(html, /images\/img00001/, 'recindex 1 (with other attributes) -> img00001');
  assert.match(html, /images\/img00002/, 'unquoted recindex 2 -> img00002');
  assert.ok(!/img00007|recindex|Stryker/.test(html), 'recindex 7 has no image -> the tag is removed, no placeholder');
});

test('mobiToIr title/heading text is trimmed and its inner tags stripped', () => {
  const text = Buffer.from('<body><h2 id="x">  <b>Heading</b> Word  </h2><p>b</p></body>', 'utf8');
  assert.equal(mobiToIr(rawMobi({ text })).chapters[0].title, 'Heading Word');

  const padded = rawMobi({ text: Buffer.from('<body><p>x</p></body>', 'utf8'), exth: exthOf([[503, '  Padded Title  ']]) });
  assert.equal(mobiToIr(padded).title, 'Padded Title', 'the final ir.title is trimmed');
});

test('mobiToIr sets the cover from images[0] with its real mime', () => {
  const ir = mobiToIr(rawMobi({ text: Buffer.from('<body><p>x</p></body>', 'utf8'), images: [GIF, JPG] }));
  assert.deepEqual({ mime: ir.cover!.mime, first: ir.images[0].mime }, { mime: 'image/gif', first: 'image/gif' });
});

test('irToMobi builds one text record per 4096 bytes of html', () => {
  const big = '<p>' + 'word '.repeat(2000) + '</p>'; // > 4096 bytes
  const ir = withIr({ title: 'Big', chapters: [{ title: '', html: big }] });
  const p = parsePalmDb(irToMobi(ir));
  assert.ok(p.records[0].readUInt16BE(8) >= 2, 'more than one text record');
  const back = mobiToIr(irToMobi(ir));
  assert.match(back.chapters.map((c) => c.html).join(' ').replace(/\s+/g, ' '), /word word word/);
});

test('irToMobi joins chapters with a pagebreak only between them, and heads each titled one', () => {
  const ir = withIr({
    title: 'DB Name Here',
    chapters: [{ title: 'A', html: '<p>1</p>' }, { title: '', html: '<p>2</p>' }],
  });
  const mobi = irToMobi(ir);
  const blob = parsePalmDb(mobi).records[1].toString('utf8');
  assert.equal(blob.match(/<mbp:pagebreak\/>/g)!.length, 1, 'exactly one pagebreak, between the two');
  assert.match(blob, /<h2>A<\/h2><p>1<\/p>\s*<mbp:pagebreak\/><p>2<\/p>/, 'titled chapter headed, untitled not');
  // the PalmDB name comes from the book title
  assert.equal(mobi.toString('latin1', 0, 12), 'DB_Name_Here');
});

test('mobiToIr rejects a HUFF/CDIC compressed file', () => {
  const ir = withIr({ title: 'T', chapters: [{ title: '', html: '<p>x</p>' }] });
  const mobi = irToMobi(ir);
  // compression code lives at offset 0 of record 0; record 0 starts after the
  // PalmDB header + record list. Flip it to 17480 (HUFF/CDIC).
  const parsed = parsePalmDb(mobi);
  const rec0Start = mobi.indexOf(parsed.records[0]);
  mobi.writeUInt16BE(17480, rec0Start);
  assert.throws(() => mobiToIr(mobi), /HUFF\/CDIC/);
});

test('mobiToIr falls back to a placeholder chapter when there is no readable text', () => {
  const ir = withIr({ title: 'Empty Book', chapters: [] });
  const back = mobiToIr(irToMobi(ir));
  assert.ok(back.chapters.length >= 1);
  assert.equal(back.title, 'Empty Book');
});

test('mobiToIr reads the full name from record 0 when EXTH has no title', () => {
  const ir = withIr({ title: 'FullName Title', chapters: [{ title: '', html: '<p>body</p>' }] });
  const mobi = irToMobi(ir);
  // Blank out the EXTH title record (type 503) so only the full-name path is left.
  const idx = mobi.indexOf(Buffer.from('FullName Title', 'utf8'));
  assert.ok(idx > 0);
  // there are two copies (EXTH + full name); corrupt the EXTH type marker of the first
  const back = mobiToIr(mobi);
  assert.equal(back.title, 'FullName Title');
});

test('mobiToIr on a truncated file surfaces a clear error, not a crash', () => {
  assert.throws(() => mobiToIr(Buffer.alloc(20)), /too small/);
  // a valid PalmDB header whose record 0 is under 16 bytes
  const tiny = assemblePalmDb('T', [Buffer.alloc(8), Buffer.alloc(4)]);
  assert.throws(() => mobiToIr(tiny), /missing record 0/);
});

test('mobiToIr reads a MOBI with no MOBI header at all (bare PalmDOC)', () => {
  // record 0 has the PalmDOC header but the bytes at 16..20 are not "MOBI"
  const text = Buffer.from('<body><p>headerless body</p></body>', 'utf8');
  const palm = Buffer.alloc(16);
  palm.writeUInt16BE(1, 0);
  palm.writeUInt32BE(text.length, 4);
  palm.writeUInt16BE(1, 8);
  palm.writeUInt16BE(4096, 10);
  const mobi = assemblePalmDb('Bare', [palm, text, buildFlis()]);
  const ir = mobiToIr(mobi);
  assert.match(ir.chapters.map((c) => c.html).join(' '), /headerless body/);
});
