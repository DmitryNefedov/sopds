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

test('mobiMeta reorders a two-token EXTH author and leaves a comma name alone', () => {
  const two = mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[100, 'William Gibson']] }));
  assert.deepEqual(two.authors, ['Gibson William']);
  const comma = mobiMeta(buildMobi({ extraRecords: [Buffer.alloc(4)], exth: [[100, 'Gibson, William']] }));
  assert.deepEqual(comma.authors, ['Gibson, William']);
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

test('mobiMeta decodes a windows-1252 full name', () => {
  const m = mobiMeta(buildMobi({ fullName: 'Café', encoding: 1252, extraRecords: [Buffer.alloc(4)] }));
  assert.equal(m.title, 'Café');
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
