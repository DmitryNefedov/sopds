import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobiMeta, mobiCover } from '../src/formats/mobi.js';

// mobiMeta / mobiCover read PalmDB + MOBI record 0 + EXTH by raw offset. These
// build just enough of that structure by hand so every branch has a fixture.

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(58)]);

type Exth = Array<[number, string | Buffer]>;

interface MobiOpts {
  fullName?: string;
  encoding?: number; // 1252 or 65001
  exth?: Exth;
  exthFlagsPresent?: boolean;
  hasMobiMagic?: boolean;
  palmType?: string; // bytes 60..64
  palmCreator?: string; // bytes 64..68
  extraRecords?: Buffer[]; // records after record 0
  firstImageIndex?: number;
  /** override the number written at PalmDB offset 76 */
  numRecordsField?: number;
}

function buildExth(entries: Exth): Buffer {
  const recs = entries.map(([type, val]) => {
    const data = Buffer.isBuffer(val) ? val : Buffer.from(val, 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32BE(type, 0);
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(recs);
  const head = Buffer.alloc(12);
  head.write('EXTH', 0, 'latin1');
  head.writeUInt32BE(12 + body.length, 4);
  head.writeUInt32BE(recs.length, 8);
  return Buffer.concat([head, body]);
}

function buildMobi(opts: MobiOpts = {}): Buffer {
  const {
    fullName = 'Test Title',
    encoding = 65001,
    exth = [],
    exthFlagsPresent = true,
    hasMobiMagic = true,
    palmType = 'BOOK',
    palmCreator = 'MOBI',
    extraRecords = [],
    firstImageIndex = 0,
    numRecordsField,
  } = opts;

  const MOBI_HEADER_LEN = 0xf8; // >= 0xe4, generous
  const mobi = Buffer.alloc(MOBI_HEADER_LEN);
  if (hasMobiMagic) mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(MOBI_HEADER_LEN, 4); // header length (rec0 offset 20)
  mobi.writeUInt32BE(encoding, 12); //         text encoding (rec0 offset 28)
  // full-name offset/length live at rec0 0x54 / 0x58 => mobi header 0x44 / 0x48
  const fullNameBuf = Buffer.from(fullName, encoding === 1252 ? 'latin1' : 'utf8');
  // rec0 = palmdoc(16) + mobi header + exth + fullname
  const exthBuf = exth.length || exthFlagsPresent ? buildExth(exth) : Buffer.alloc(0);
  const fullNameOffset = 16 + MOBI_HEADER_LEN + exthBuf.length;
  mobi.writeUInt32BE(fullNameOffset, 0x54 - 16);
  mobi.writeUInt32BE(fullNameBuf.length, 0x58 - 16);
  mobi.writeUInt32BE(firstImageIndex, 0x6c - 16); // first image index
  mobi.writeUInt32BE(exthFlagsPresent ? 0x40 : 0, 0x80 - 16); // EXTH flags

  const palmDoc = Buffer.alloc(16);
  palmDoc.writeUInt16BE(1, 0); // compression none

  const rec0 = Buffer.concat([palmDoc, mobi, exthBuf, fullNameBuf]);
  const records = [rec0, ...extraRecords];

  const numRecords = numRecordsField ?? records.length;
  const headerLen = 78 + records.length * 8 + 2;
  const head = Buffer.alloc(78);
  head.write(palmType, 60, 'latin1');
  head.write(palmCreator, 64, 'latin1');
  head.writeUInt16BE(numRecords, 76);

  const recList = Buffer.alloc(records.length * 8 + 2);
  let offset = headerLen;
  for (let i = 0; i < records.length; i++) {
    recList.writeUInt32BE(offset, i * 8);
    offset += records[i].length;
  }
  return Buffer.concat([head, recList, ...records]);
}

// --- mobiMeta ---------------------------------------------------------

test('mobiMeta reads the full-name record and derives the lang code', () => {
  const m = mobiMeta(buildMobi({ fullName: 'Neuromancer', extraRecords: [Buffer.alloc(4)] }));
  assert.equal(m.title, 'Neuromancer');
  assert.equal(m.langCode, 2);
});

test('mobiMeta returns empty strings (not defaults) for absent fields', () => {
  const m = mobiMeta(buildMobi({ fullName: 'T', extraRecords: [Buffer.alloc(4)] }));
  assert.equal(m.docdate, '');
  assert.equal(m.lang, '');
  assert.deepEqual(m.genres, []);
  assert.equal(m.series, null);
});

test('mobiMeta EXTH 503 keeps the full-name title when the value is empty', () => {
  const m = mobiMeta(buildMobi({ fullName: 'FromRecord', exth: [[503, '']], extraRecords: [Buffer.alloc(4)] }));
  assert.equal(m.title, 'FromRecord');
});

test('mobiMeta applies EXTH 509 only to a 509 record', () => {
  // A trailing type-1 record carrying "5" must not be parsed as the series index.
  const m = mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[508, 'Saga'], [1, '5']] }));
  assert.deepEqual(m.series, { title: 'Saga', index: 0 }, 'only a 509 record sets the index');
});

test('mobiMeta EXTH 509 needs a numeric series index', () => {
  assert.deepEqual(
    mobiMeta(buildMobi({ exth: [[508, 'S'], [509, '12abc']], extraRecords: [Buffer.alloc(4)] })).series,
    { title: 'S', index: 12 },
    'parseInt takes the leading digits',
  );
  assert.deepEqual(
    mobiMeta(buildMobi({ exth: [[508, 'S'], [509, 'zz']], extraRecords: [Buffer.alloc(4)] })).series,
    { title: 'S', index: 0 },
  );
});

test('mobiMeta stops the EXTH walk at a size-under-8 record', () => {
  const bad = (() => { const h = Buffer.alloc(8); h.writeUInt32BE(524, 0); h.writeUInt32BE(6, 4); return h; })();
  const good = (() => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(100, 0);
    h.writeUInt32BE(8 + 3, 4);
    return Buffer.concat([h, Buffer.from('Ann')]);
  })();
  const body = Buffer.concat([good, bad, Buffer.from('xx')]);
  const exthHead = Buffer.alloc(12);
  exthHead.write('EXTH', 0, 'latin1');
  exthHead.writeUInt32BE(12 + body.length, 4);
  exthHead.writeUInt32BE(3, 8);
  const HLEN = 0xf8;
  const mobi = Buffer.alloc(HLEN);
  mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(HLEN, 4);
  mobi.writeUInt32BE(0x40, 0x80 - 16);
  const rec0 = Buffer.concat([Buffer.alloc(16), mobi, exthHead, body, Buffer.alloc(8)]);
  const records = [rec0, Buffer.alloc(4)];
  const headerLen = 78 + records.length * 8 + 2;
  const head = Buffer.alloc(78);
  head.write('BOOK', 60, 'latin1');
  head.write('MOBI', 64, 'latin1');
  head.writeUInt16BE(records.length, 76);
  const rl = Buffer.alloc(records.length * 8 + 2);
  let off = headerLen;
  for (let i = 0; i < records.length; i++) { rl.writeUInt32BE(off, i * 8); off += records[i].length; }
  const m = mobiMeta(Buffer.concat([head, rl, ...records]));
  assert.deepEqual(m.authors, ['Ann']);
  assert.equal(m.lang, '', 'the size-6 language record was never applied');
});

test('mobiMeta pulls author / title / language / genre / date / series from EXTH', () => {
  const m = mobiMeta(
    buildMobi({
      fullName: 'placeholder',
      extraRecords: [Buffer.alloc(4)],
      exth: [
        [100, 'William Gibson'],
        [503, 'Count Zero'],
        [524, 'en'],
        [105, 'Cyberpunk'],
        [106, '1986-03-01'],
        [508, 'Sprawl'],
        [509, '2'],
      ],
    }),
  );
  assert.deepEqual(m.authors, ['Gibson William'], 'two-token author reordered last-first');
  assert.equal(m.title, 'Count Zero', 'EXTH 503 overrides the full-name record');
  assert.equal(m.lang, 'en');
  assert.deepEqual(m.genres, ['cyberpunk'], 'lower-cased');
  assert.equal(m.docdate, '1986-03-01');
  assert.deepEqual(m.series, { title: 'Sprawl', index: 2 });
});

test('mobiMeta reorders EXTH author names last-token-first', () => {
  assert.deepEqual(mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[100, 'William Gibson']] })).authors, ['Gibson William']);
  // 3 tokens: slice(0, -1) must keep the first two, joined with a space.
  assert.deepEqual(
    mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[100, 'Ann B Charles']] })).authors,
    ['Charles Ann B'],
  );
  // runs of whitespace collapse
  assert.deepEqual(
    mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[100, 'Ann  B  Charles']] })).authors,
    ['Charles Ann B'],
  );
  // a single token is left as-is; a comma name is left as-is
  assert.deepEqual(mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[100, 'Voltaire']] })).authors, ['Voltaire']);
  assert.deepEqual(mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[100, 'Gibson, William']] })).authors, ['Gibson, William']);
});

test('mobiMeta filters out a blank EXTH-100 author', () => {
  assert.deepEqual(
    mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[100, ''], [100, 'Real Name']] })).authors,
    ['Name Real'],
  );
});

test('mobiMeta trims decoded EXTH values', () => {
  const m = mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[524, '  ru  '], [503, '  Trimmed  ']] }));
  assert.equal(m.lang, 'ru');
  assert.equal(m.title, 'Trimmed');
});

test('mobiMeta keeps the full-name title when EXTH 503 is empty', () => {
  const m = mobiMeta(buildMobi({ fullName: 'Kept', extraRecords: [Buffer.alloc(4)], exth: [[503, '']] }));
  assert.equal(m.title, 'Kept');
});

test('mobiMeta defaults a non-numeric series index to 0 and needs a series name', () => {
  const noName = mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[509, '3']] }));
  assert.equal(noName.series, null);
  const badIdx = mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[508, 'S'], [509, 'x']] }));
  assert.deepEqual(badIdx.series, { title: 'S', index: 0 });
});

test('mobiMeta stops at an EXTH entry whose size field is under 8', () => {
  // Hand-roll a broken EXTH: a valid author then a record claiming size 4.
  const good = Buffer.concat([
    (() => { const h = Buffer.alloc(8); h.writeUInt32BE(100, 0); h.writeUInt32BE(8 + 4, 4); return h; })(),
    Buffer.from('Real'),
  ]);
  const broken = (() => { const h = Buffer.alloc(8); h.writeUInt32BE(524, 0); h.writeUInt32BE(4, 4); return h; })();
  const body = Buffer.concat([good, broken, Buffer.from('xxxx')]);
  const exthHead = Buffer.alloc(12);
  exthHead.write('EXTH', 0, 'latin1');
  exthHead.writeUInt32BE(12 + body.length, 4);
  exthHead.writeUInt32BE(3, 8); // claims 3 entries
  const exthBuf = Buffer.concat([exthHead, body]);

  const MOBI_HEADER_LEN = 0xf8;
  const mobi = Buffer.alloc(MOBI_HEADER_LEN);
  mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(MOBI_HEADER_LEN, 4);
  mobi.writeUInt32BE(65001, 8);
  mobi.writeUInt32BE(0x40, 0x80 - 16);
  const rec0 = Buffer.concat([Buffer.alloc(16), mobi, exthBuf]);
  const records = [rec0, Buffer.alloc(4)];
  const headerLen = 78 + records.length * 8 + 2;
  const head = Buffer.alloc(78);
  head.write('BOOK', 60, 'latin1');
  head.write('MOBI', 64, 'latin1');
  head.writeUInt16BE(records.length, 76);
  const recList = Buffer.alloc(records.length * 8 + 2);
  let off = headerLen;
  for (let i = 0; i < records.length; i++) { recList.writeUInt32BE(off, i * 8); off += records[i].length; }
  const m = mobiMeta(Buffer.concat([head, recList, ...records]));
  assert.deepEqual(m.authors, ['Real'], 'the author before the broken entry survives');
  assert.equal(m.lang, '', 'parsing stopped, so language 524 was never read');
});

test('mobiMeta returns the empty shape for a buffer that is too small', () => {
  const m = mobiMeta(Buffer.alloc(40));
  assert.equal(m.title, '');
  assert.deepEqual(m.authors, []);
});

test('mobiMeta returns the empty shape when bytes 60..64 are not "BOOK"', () => {
  const buf = buildMobi({ palmType: 'PDB\0', extraRecords: [Buffer.alloc(4)] });
  const m = mobiMeta(buf);
  assert.equal(m.title, '');
});

test('mobiMeta returns the empty shape when record 0 lacks the MOBI magic', () => {
  const m = mobiMeta(buildMobi({ hasMobiMagic: false, extraRecords: [Buffer.alloc(4)] }));
  assert.equal(m.title, '');
});

test('mobiMeta decodes a windows-1252 full name and utf-8 for any other encoding', () => {
  assert.equal(mobiMeta(buildMobi({ fullName: 'Café', encoding: 1252, extraRecords: [Buffer.alloc(4)] })).title, 'Café');
  assert.equal(mobiMeta(buildMobi({ fullName: 'Тест', encoding: 65001, extraRecords: [Buffer.alloc(4)] })).title, 'Тест');
});

test('mobiMeta needs at least 78 bytes even when "BOOK" is present', () => {
  const short = buildMobi({ extraRecords: [Buffer.alloc(4)] }).subarray(0, 77);
  assert.equal(mobiMeta(short).title, '');
});

test('mobiMeta reads rec0End from the record list only when there is more than one record', () => {
  // A single-record file: rec0 runs to the end of the buffer. The full name is
  // near the front, so it is still read.
  const m = mobiMeta(buildMobi({ fullName: 'Solo', extraRecords: [] }));
  assert.equal(m.title, 'Solo');
});

test('mobiMeta ignores a zero full-name offset', () => {
  // buildMobi always writes a real offset; craft one with offset 0.
  const buf = buildMobi({ fullName: 'x', extraRecords: [Buffer.alloc(4)] });
  // 0x54 within rec0 -> after the 78-byte PalmDB header + record list.
  const rec0Start = buf.readUInt32BE(78);
  buf.writeUInt32BE(0, rec0Start + 0x54);
  assert.equal(mobiMeta(buf).title, '', 'offset 0 -> no title read');
});

test('mobiMeta stops the EXTH walk when a record would run past the buffer', () => {
  // count says 5 but only one real record fits before rec0 ends.
  const exthBody = (() => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(100, 0);
    h.writeUInt32BE(8 + 4, 4);
    return Buffer.concat([h, Buffer.from('Solo')]);
  })();
  const exthHead = Buffer.alloc(12);
  exthHead.write('EXTH', 0, 'latin1');
  exthHead.writeUInt32BE(12 + exthBody.length, 4);
  exthHead.writeUInt32BE(5, 8); // lies: claims 5 entries
  const exthBuf = Buffer.concat([exthHead, exthBody]);

  const HLEN = 0xf8;
  const mobi = Buffer.alloc(HLEN);
  mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(HLEN, 4);
  mobi.writeUInt32BE(65001, 12);
  mobi.writeUInt32BE(0x40, 0x80 - 16);
  const rec0 = Buffer.concat([Buffer.alloc(16), mobi, exthBuf]); // no slack after EXTH
  const records = [rec0, Buffer.alloc(4)];
  const headerLen = 78 + records.length * 8 + 2;
  const head = Buffer.alloc(78);
  head.write('BOOK', 60, 'latin1');
  head.write('MOBI', 64, 'latin1');
  head.writeUInt16BE(records.length, 76);
  const rl = Buffer.alloc(records.length * 8 + 2);
  let off = headerLen;
  for (let i = 0; i < records.length; i++) { rl.writeUInt32BE(off, i * 8); off += records[i].length; }
  assert.deepEqual(mobiMeta(Buffer.concat([head, rl, ...records])).authors, ['Solo']);
});

test('mobiMeta does not read EXTH when the flag bit 0x40 is clear', () => {
  const m = mobiMeta(buildMobi({ exthFlagsPresent: false, fullName: 'Only Name', extraRecords: [Buffer.alloc(4)] }));
  assert.equal(m.title, 'Only Name');
  assert.deepEqual(m.authors, []);
});

test('mobiMeta requires the literal "EXTH" magic', () => {
  const buf = buildMobi({ exth: [[100, 'Ghost']], extraRecords: [Buffer.alloc(4)] });
  const rec0Start = buf.readUInt32BE(78);
  // EXTH sits at rec0 + 16 + mobiHeaderLen(0xf8).
  buf.write('XXXX', rec0Start + 16 + 0xf8, 'latin1');
  assert.deepEqual(mobiMeta(buf).authors, [], 'no EXTH magic -> no EXTH parsing');
});

// --- mobiCover ------------------------------------------------------

const GIF2 = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(58)]);

test('mobiCover returns null when the record count is zero', () => {
  const buf = buildMobi({ extraRecords: [Buffer.alloc(4)], numRecordsField: 0 });
  assert.equal(mobiCover(buf), null);
});

test('mobiCover scans from record 1 when record 0 has no MOBI magic', () => {
  const buf = buildMobi({ hasMobiMagic: false, extraRecords: [JPEG] });
  assert.ok(mobiCover(buf)?.data.equals(JPEG));
});

test('mobiCover skips EXTH entirely when the 0x40 flag is clear', () => {
  const buf = buildMobi({
    exthFlagsPresent: false,
    firstImageIndex: 1,
    extraRecords: [PNG, JPEG],
  });
  assert.ok(mobiCover(buf)?.data.equals(PNG), 'no EXTH -> straight to the first image scan');
});

test('mobiCover breaks out of the EXTH walk at a size-under-8 record', () => {
  // 201 record claims size 4 -> break before it is read -> no coverOffset.
  const bad201 = (() => { const h = Buffer.alloc(8); h.writeUInt32BE(201, 0); h.writeUInt32BE(4, 4); return h; })();
  const HLEN = 0xf8;
  const mobi = Buffer.alloc(HLEN);
  mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(HLEN, 4);
  mobi.writeUInt32BE(0x40, 0x80 - 16);
  mobi.writeUInt32BE(2, 0x6c - 16); // firstImageIndex
  const exthHead = Buffer.alloc(12);
  exthHead.write('EXTH', 0, 'latin1');
  exthHead.writeUInt32BE(12 + bad201.length + 4, 4);
  exthHead.writeUInt32BE(1, 8);
  const rec0 = Buffer.concat([Buffer.alloc(16), mobi, exthHead, bad201, Buffer.from('xxxx')]);
  const records = [rec0, Buffer.from('text'), JPEG];
  const headerLen = 78 + records.length * 8 + 2;
  const head = Buffer.alloc(78);
  head.write('BOOK', 60, 'latin1');
  head.write('MOBI', 64, 'latin1');
  head.writeUInt16BE(records.length, 76);
  const rl = Buffer.alloc(records.length * 8 + 2);
  let off = headerLen;
  for (let i = 0; i < records.length; i++) { rl.writeUInt32BE(off, i * 8); off += records[i].length; }
  const buf = Buffer.concat([head, rl, ...records]);
  // coverOffset never set -> falls back to the first-image scan from base (2).
  assert.ok(mobiCover(buf)?.data.equals(JPEG));
});

test('mobiCover treats firstImageIndex of 0 or >= numRecords as "no base"', () => {
  const zero = buildMobi({ firstImageIndex: 0, extraRecords: [Buffer.from('t'), JPEG] });
  assert.ok(mobiCover(zero)?.data.equals(JPEG), 'base null -> firstImage scans from 1');
  const tooBig = buildMobi({ firstImageIndex: 99, extraRecords: [Buffer.from('t'), JPEG] });
  assert.ok(mobiCover(tooBig)?.data.equals(JPEG));
});

test('mobiCover ignores a cover record number outside the record range', () => {
  const big = Buffer.alloc(4);
  big.writeUInt32BE(500, 0); // base(2) + 500 is way out of range
  const buf = buildMobi({
    exth: [[201, big]],
    firstImageIndex: 2,
    extraRecords: [Buffer.from('t'), JPEG],
  });
  assert.ok(mobiCover(buf)?.data.equals(JPEG), 'bad record no -> tryRecord returns null -> first image');
});

test('mobiCover ignores a cover record that is not an image, then tries the thumb', () => {
  const cov = Buffer.alloc(4); cov.writeUInt32BE(0, 0); // base + 0 -> record "base"
  const thumb = Buffer.alloc(4); thumb.writeUInt32BE(1, 0); // base + 1
  const buf = buildMobi({
    exth: [[201, cov], [202, thumb]],
    firstImageIndex: 2,
    extraRecords: [Buffer.from('t'), Buffer.from('NOT AN IMAGE aaaaaaaa'), PNG],
  });
  assert.ok(mobiCover(buf)?.data.equals(PNG), 'cover rec not an image -> thumb rec is');
});

test('mobiCover skips a 0xffffffff cover offset but still tries the thumb', () => {
  const none = Buffer.alloc(4); none.writeUInt32BE(0xffffffff, 0);
  const thumb = Buffer.alloc(4); thumb.writeUInt32BE(1, 0);
  const buf = buildMobi({
    exth: [[201, none], [202, thumb]],
    firstImageIndex: 2,
    extraRecords: [Buffer.from('t'), GIF2, JPEG],
  });
  assert.ok(mobiCover(buf)?.data.equals(JPEG), 'cover sentinel skipped; thumb (base+1) used');
});

test('mobiCover skips a 0xffffffff thumb offset', () => {
  const none = Buffer.alloc(4); none.writeUInt32BE(0xffffffff, 0);
  const buf = buildMobi({
    exth: [[202, none]],
    firstImageIndex: 2,
    extraRecords: [Buffer.from('t'), JPEG],
  });
  assert.ok(mobiCover(buf)?.data.equals(JPEG), 'thumb sentinel skipped; first-image scan');
});

test('mobiCover first-image scan starts at base, and stops at FLIS or FCIS', () => {
  const flis = Buffer.concat([Buffer.from('FLIS'), Buffer.alloc(20)]);
  const fcis = Buffer.concat([Buffer.from('FCIS'), Buffer.alloc(20)]);
  assert.equal(
    mobiCover(buildMobi({ exth: [], firstImageIndex: 2, extraRecords: [Buffer.from('t'), flis, JPEG] })),
    null,
    'FLIS stops the scan before the JPEG',
  );
  assert.equal(
    mobiCover(buildMobi({ exth: [], firstImageIndex: 2, extraRecords: [Buffer.from('t'), fcis, JPEG] })),
    null,
    'FCIS also stops the scan',
  );
});

test('mobiCover returns null when reading a record offset throws (corrupt count)', () => {
  const buf = buildMobi({ extraRecords: [JPEG], numRecordsField: 9999 });
  assert.equal(mobiCover(buf), null, 'the out-of-bounds read is caught');
});

// --- mobiCover --------------------------------------------------------

test('mobiCover returns the EXTH-201 cover record', () => {
  // rec0, one text record, then image records. firstImageIndex points at the
  // first image; EXTH 201 gives the offset from there.
  const cover201 = Buffer.alloc(4);
  cover201.writeUInt32BE(1, 0); // cover is image #1 (0-based) from firstImageIndex
  const buf = buildMobi({
    exth: [[201, cover201]],
    firstImageIndex: 2, // rec0=0, text=1, images start at 2
    extraRecords: [Buffer.from('text record'), GIF, JPEG],
  });
  const c = mobiCover(buf);
  assert.ok(c);
  assert.equal(c.mime, 'image/jpeg', 'record 2 + offset 1 = record 3 = the JPEG');
  assert.ok(c.data.equals(JPEG));
});

test('mobiCover falls back to EXTH 202 (thumbnail) then to the first image', () => {
  const thumb = Buffer.alloc(4);
  thumb.writeUInt32BE(0, 0);
  const withThumb = buildMobi({
    exth: [[202, thumb]],
    firstImageIndex: 2,
    extraRecords: [Buffer.from('text'), PNG, JPEG],
  });
  assert.ok(mobiCover(withThumb)?.data.equals(PNG), 'thumb offset 0 -> first image record');

  const noExth = buildMobi({
    exth: [],
    firstImageIndex: 2,
    extraRecords: [Buffer.from('text'), JPEG, PNG],
  });
  assert.ok(mobiCover(noExth)?.data.equals(JPEG), 'no 201/202 -> scan from the first image');
});

test('mobiCover ignores a 0xffffffff cover/thumb sentinel', () => {
  const none = Buffer.alloc(4);
  none.writeUInt32BE(0xffffffff, 0);
  const buf = buildMobi({
    exth: [[201, none]],
    firstImageIndex: 2,
    extraRecords: [Buffer.from('text'), JPEG],
  });
  assert.ok(mobiCover(buf)?.data.equals(JPEG), 'sentinel skipped, first image used');
});

test('mobiCover stops scanning at a FLIS/FCIS trailer record', () => {
  const buf = buildMobi({
    exth: [],
    firstImageIndex: 2,
    extraRecords: [Buffer.from('text'), Buffer.concat([Buffer.from('FLIS'), Buffer.alloc(20)]), JPEG],
  });
  assert.equal(mobiCover(buf), null, 'the JPEG after FLIS is never reached');
});

test('mobiCover returns null for a non-MOBI or empty buffer', () => {
  assert.equal(mobiCover(Buffer.alloc(40)), null);
  assert.equal(mobiCover(buildMobi({ palmType: 'ZZZZ', palmCreator: 'ZZZZ', extraRecords: [Buffer.alloc(4)] })), null);
});

test('mobiCover with no MOBI header in record 0 still scans records for an image', () => {
  const buf = buildMobi({
    hasMobiMagic: false,
    extraRecords: [Buffer.from('x'), JPEG],
  });
  assert.ok(mobiCover(buf)?.data.equals(JPEG), 'falls back to scanning from record 1');
});
