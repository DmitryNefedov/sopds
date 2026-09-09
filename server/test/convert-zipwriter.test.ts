import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import { ZipWriter, crc32, dosDateTime } from '../src/services/convert/zipwriter.js';

// The minimal ZIP writer behind EPUB output.

test('crc32 matches the reference implementation', () => {
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('a')), 0xe8b7be43);
  assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  const big = Buffer.from('x'.repeat(5000) + 'payload');
  assert.equal(crc32(big) >>> 0, zlib.crc32!(big) >>> 0);
});

test('dosDateTime packs the clock into the two 16-bit DOS fields', () => {
  const { time, date } = dosDateTime(new Date(2021, 5, 15, 13, 30, 44));
  assert.equal(time, (13 << 11) | (30 << 5) | 22, 'hours<<11 | minutes<<5 | seconds/2');
  assert.equal(date, ((2021 - 1980) << 9) | ((5 + 1) << 5) | 15, '(year-1980)<<9 | (month+1)<<5 | day');
  // an odd second is floored, not rounded
  assert.equal(dosDateTime(new Date(2000, 0, 1, 0, 0, 59)).time, 29);
  const { date: d2 } = dosDateTime(new Date(1980, 0, 1, 0, 0, 0));
  assert.equal(d2, (1 << 5) | 1, 'the DOS epoch: year 1980, month 1, day 1');
});

function entriesOf(buf: Buffer): AdmZip.IZipEntry[] {
  return new AdmZip(buf).getEntries();
}

test('a written archive round-trips through a real unzip, contents and names intact', () => {
  const w = new ZipWriter();
  w.add('mimetype', 'application/epub+zip', { store: true });
  w.add('META-INF/container.xml', '<container/>');
  w.add('chap.xhtml', Buffer.from('<html>body</html>'));
  const zip = w.toBuffer();

  const entries = entriesOf(zip);
  assert.deepEqual(
    entries.map((e) => e.entryName),
    ['mimetype', 'META-INF/container.xml', 'chap.xhtml'],
    'entries kept in insertion order',
  );
  assert.equal(new AdmZip(zip).readAsText('mimetype'), 'application/epub+zip');
  assert.equal(new AdmZip(zip).readAsText('META-INF/container.xml'), '<container/>');
  assert.equal(new AdmZip(zip).readFile('chap.xhtml')!.toString(), '<html>body</html>');
});

test('the store flag controls compression: mimetype is STORED, everything else DEFLATED', () => {
  const w = new ZipWriter();
  w.add('stored.txt', 'x'.repeat(500), { store: true });
  w.add('deflated.txt', 'x'.repeat(500));
  const entries = entriesOf(w.toBuffer());
  const stored = entries.find((e) => e.entryName === 'stored.txt')!;
  const deflated = entries.find((e) => e.entryName === 'deflated.txt')!;
  // method: 0 = stored, 8 = deflate
  assert.equal((stored.header as unknown as { method: number }).method, 0);
  assert.equal((deflated.header as unknown as { method: number }).method, 8);
  assert.equal(stored.header.compressedSize, 500, 'stored: compressed size == raw size');
  assert.ok(deflated.header.compressedSize < 500, 'deflated: actually smaller');
});

test('add() defaults to compression when no options are given', () => {
  const entries = entriesOf(new ZipWriter().add('a.txt', 'y'.repeat(400)).toBuffer());
  assert.equal((entries[0].header as unknown as { method: number }).method, 8, 'DEFLATE by default');
});

test('the local-header fields line up at their ZIP offsets', () => {
  const payload = Buffer.from('hello zip world');
  const zip = new ZipWriter().add('f.txt', payload).toBuffer();
  // First local file header starts at byte 0.
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local file header signature');
  assert.equal(zip.readUInt16LE(4), 20, 'version-needed at offset 4');
  assert.equal(zip.readUInt16LE(8), 8, 'compression method at offset 8');
  assert.equal(zip.readUInt32LE(14), crc32(payload), 'CRC-32 at offset 14');
  assert.equal(zip.readUInt32LE(22), payload.length, 'uncompressed size at offset 22');
  assert.equal(zip.readUInt16LE(26), Buffer.byteLength('f.txt'), 'filename length at offset 26');
  const compSize = zip.readUInt32LE(18);
  assert.equal(zip.subarray(30, 35).toString(), 'f.txt', 'filename follows the 30-byte header');
  // The deflate payload sits right after the name and inflates back.
  const deflated = zip.subarray(35, 35 + compSize);
  assert.equal(zlib.inflateRawSync(deflated).toString(), 'hello zip world');

  // The DOS time/date fields (offsets 10, 12) are non-zero and repeated verbatim
  // in the central header, so dropping either write is caught.
  const dtime = zip.readUInt16LE(10);
  const ddate = zip.readUInt16LE(12);
  assert.notEqual(ddate, 0, 'the DOS date is stamped (year >= 1980)');
  const parsed = new AdmZip(zip).getEntries()[0].header.time;
  assert.equal(parsed.getFullYear(), new Date().getFullYear(), 'stamped with the current year');

  const eocd = zip.length - 22;
  const cd = zip.readUInt32LE(eocd + 16);
  assert.equal(zip.readUInt16LE(cd + 4), 20, 'central version-made-by at offset 4');
  assert.equal(zip.readUInt16LE(cd + 6), 20, 'central version-needed at offset 6');
  assert.equal(zip.readUInt16LE(cd + 12), dtime, 'central time field matches the local one');
  assert.equal(zip.readUInt16LE(cd + 14), ddate, 'central date field matches the local one');
  assert.equal(zip.readUInt32LE(cd + 16), crc32(payload), 'central CRC-32 at offset 16');
});

test('the end-of-central-directory record reports the entry count and sizes', () => {
  const zip = new ZipWriter().add('a', 'aa').add('b', 'bb').add('c', 'cc').toBuffer();
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50, 'EOCD signature');
  assert.equal(zip.readUInt16LE(eocd + 8), 3, 'entries on this disk');
  assert.equal(zip.readUInt16LE(eocd + 10), 3, 'entries total');
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  assert.equal(zip.readUInt32LE(cdOffset), 0x02014b50, 'central directory starts where EOCD says');
  assert.equal(cdOffset + cdSize, eocd, 'central directory ends exactly at the EOCD');
});

test('add() is chainable', () => {
  const w = new ZipWriter();
  assert.equal(w.add('a', 'x'), w);
});
