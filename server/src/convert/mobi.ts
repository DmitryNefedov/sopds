import { emptyIr, escapeXml, sanitizeHtml } from './ir.js';
import type { Ir } from './ir.js';

// Pure-JS MOBI (MOBI6 / PalmDOC) reader + writer.
//
// Reading supports uncompressed and PalmDOC-compressed text. HUFF/CDIC
// compression (used by newer Amazon-generated files) is detected and reported
// rather than mis-decoded.

// ---------------------------------------------------------------------------
// PalmDB parsing helpers
// ---------------------------------------------------------------------------

function parsePalmDb(buf: Buffer): { type: string; creator: string; records: Buffer[] } {
  if (buf.length < 78) throw new Error('MOBI: file too small');
  const type = buf.toString('latin1', 60, 64);
  const creator = buf.toString('latin1', 64, 68);
  if (creator !== 'MOBI' && creator !== 'TPZ') {
    // still try — some tools omit creator, but bail on obvious non-mobi
  }
  const numRecords = buf.readUInt16BE(76);
  const records: number[] = [];
  for (let i = 0; i < numRecords; i++) {
    const p = 78 + i * 8;
    const offset = buf.readUInt32BE(p);
    records.push(offset);
  }
  records.push(buf.length); // sentinel for last record end
  const slices: Buffer[] = [];
  for (let i = 0; i < numRecords; i++) {
    slices.push(buf.subarray(records[i], records[i + 1]));
  }
  return { type, creator, records: slices };
}

// ---------------------------------------------------------------------------
// PalmDOC (LZ77) decompression
// ---------------------------------------------------------------------------

function palmDocDecompress(input: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const b = input[i++];
    if (b === 0) {
      out.push(0);
    } else if (b <= 8) {
      for (let j = 0; j < b && i < n; j++) out.push(input[i++]);
    } else if (b <= 0x7f) {
      out.push(b);
    } else if (b <= 0xbf) {
      if (i >= n) break;
      const lz = (b << 8) | input[i++];
      const distance = (lz >> 3) & 0x7ff;
      const length = (lz & 0x07) + 3;
      let start = out.length - distance;
      for (let j = 0; j < length; j++) out.push(out[start + j]);
    } else {
      out.push(32);
      out.push(b ^ 0x80);
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// trailing "extra data" stripping
// ---------------------------------------------------------------------------

function stripTrailingEntries(record: Buffer, extraFlags: number): Buffer {
  let end = record.length;
  for (let flag = extraFlags >> 1; flag; flag >>= 1) {
    if (flag & 1) {
      // size is a backwards-encoded varint in the last bytes
      let pos = end;
      let size = 0;
      let bitpos = 0;
      let started = false;
      // read backwards until a byte with high bit set terminates the value
      for (let k = 1; k <= 4; k++) {
        const byte = record[end - k];
        size |= (byte & 0x7f) << bitpos;
        bitpos += 7;
        if (byte & 0x80) {
          started = true;
          // re-decode properly: MOBI stores it big-endian-ish; use standard algo
          break;
        }
      }
      size = decodeBackwardVarint(record, end);
      end -= size;
    }
  }
  if (extraFlags & 1) {
    // multibyte overlap trailer: last byte's low 2 bits +1
    const a = record[end - 1];
    end -= (a & 0x3) + 1;
  }
  return record.subarray(0, Math.max(0, end));
}

function decodeBackwardVarint(record: Buffer, end: number): number {
  let value = 0;
  let bytesConsumed = 0;
  for (let k = 1; k <= 4; k++) {
    const byte = record[end - k];
    if (k === 1) {
      value = byte & 0x7f;
    } else {
      value = ((byte & 0x7f) << (7 * (k - 1))) | value;
    }
    bytesConsumed = k;
    if (byte & 0x80) break;
  }
  // The size includes the varint bytes themselves.
  return value;
}

// ---------------------------------------------------------------------------
// EXTH
// ---------------------------------------------------------------------------

interface ExthMeta {
  authors: string[];
  title: string | null;
  language: string | null;
  coverOffset: number | null;
}
function parseExth(rec0: Buffer, start: number): ExthMeta {
  const meta: ExthMeta = { authors: [], title: null, language: null, coverOffset: null };
  if (rec0.toString('latin1', start, start + 4) !== 'EXTH') return meta;
  const len = rec0.readUInt32BE(start + 4);
  const count = rec0.readUInt32BE(start + 8);
  let p = start + 12;
  for (let i = 0; i < count && p + 8 <= start + len; i++) {
    const type = rec0.readUInt32BE(p);
    const size = rec0.readUInt32BE(p + 4);
    const data = rec0.subarray(p + 8, p + size);
    if (type === 100) meta.authors.push(data.toString('utf8'));
    else if (type === 503) meta.title = data.toString('utf8');
    else if (type === 524) meta.language = data.toString('utf8');
    else if (type === 201) meta.coverOffset = data.readUInt32BE(0);
    p += size;
  }
  return meta;
}

// ---------------------------------------------------------------------------
// MOBI -> IR
// ---------------------------------------------------------------------------

export function mobiToIr(buf: Buffer): Ir {
  const ir = emptyIr();
  const { records } = parsePalmDb(buf);
  const rec0 = records[0];
  if (!rec0 || rec0.length < 16) throw new Error('MOBI: missing record 0');

  const compression = rec0.readUInt16BE(0);
  const textLength = rec0.readUInt32BE(4);
  const recordCount = rec0.readUInt16BE(8);

  let encoding = 'utf8';
  let firstImageIndex = 0;
  let fullNameOffset = 0;
  let fullNameLength = 0;
  let mobiHeaderLen = 0;
  let extraFlags = 0;
  let hasMobiHeader = rec0.toString('latin1', 16, 20) === 'MOBI';

  if (hasMobiHeader) {
    mobiHeaderLen = rec0.readUInt32BE(20);
    const textEncoding = rec0.readUInt32BE(28);
    encoding = textEncoding === 1252 ? 'latin1' : 'utf8';
    fullNameOffset = rec0.readUInt32BE(0x54);
    fullNameLength = rec0.readUInt32BE(0x58);
    firstImageIndex = rec0.readUInt32BE(0x6c);
    const exthFlags = rec0.readUInt32BE(0x80);
    if (mobiHeaderLen >= 0xe4 && 16 + 0xf2 + 2 <= rec0.length) {
      extraFlags = rec0.readUInt16BE(16 + mobiHeaderLen - 2 >= rec0.length ? 0xf2 : 0xf2);
    }
    if (exthFlags & 0x40) {
      const exth = parseExth(rec0, 16 + mobiHeaderLen);
      if (exth.title) ir.title = exth.title;
      if (exth.authors.length) ir.authors = exth.authors;
      if (exth.language) ir.language = exth.language;
    }
    if (fullNameOffset && fullNameLength && fullNameOffset + fullNameLength <= rec0.length) {
      const nm = rec0.toString('utf8', fullNameOffset, fullNameOffset + fullNameLength);
      if (nm && (!ir.title || ir.title === 'Untitled')) ir.title = nm;
    }
  }

  if (compression === 17480) {
    throw new Error('MOBI: HUFF/CDIC-compressed files are not supported for conversion');
  }

  // assemble text
  const parts: Buffer[] = [];
  for (let i = 1; i <= recordCount && i < records.length; i++) {
    let r = records[i];
    if (!r) break;
    r = stripTrailingEntries(r, extraFlags);
    parts.push(compression === 2 ? palmDocDecompress(r) : Buffer.from(r));
  }
  let text = Buffer.concat(parts);
  if (text.length > textLength) text = text.subarray(0, textLength);
  let htmlAll = decodeText(text, encoding);

  // images: records from firstImageIndex up to recordCount-1 range; detect by magic
  const imageRecords: Array<{ mime: string; data: Buffer }> = [];
  const startImg = firstImageIndex > 0 && firstImageIndex < records.length
    ? firstImageIndex
    : recordCount + 1;
  for (let i = startImg; i < records.length - 1; i++) {
    const r = records[i];
    const mime = imageMime(r);
    if (mime) imageRecords.push({ mime, data: Buffer.from(r) });
    else if (r && r.toString('latin1', 0, 4) === 'FLIS') break;
  }
  imageRecords.forEach((im, idx) => {
    ir.images.push({ id: `img${String(idx + 1).padStart(5, '0')}`, mime: im.mime, data: im.data });
  });

  // rewrite <img recindex="N"> -> images/imgNNNNN
  htmlAll = htmlAll.replace(/<img\b[^>]*recindex=["']?(\d+)["']?[^>]*>/gi, (_m, n: string) => {
    const idx = parseInt(n, 10);
    const img = ir.images[idx - 1];
    return img ? `<img src="images/${img.id}" alt=""/>` : '';
  });

  // split into chapters on <mbp:pagebreak> / <pagebreak>
  const rawChapters = htmlAll
    .split(/<mbp:pagebreak[^>]*>|<pagebreak[^>]*>/i)
    .map((s) => sanitizeHtml(stripMobiWrappers(s)))
    .filter((s) => s.replace(/<[^>]+>/g, '').trim().length > 0);

  ir.chapters = (rawChapters.length ? rawChapters : [stripMobiWrappers(htmlAll)]).map((h) => {
    const hm = h.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    return { title: hm ? hm[1].replace(/<[^>]+>/g, '').trim() : '', html: h };
  });
  if (!ir.chapters.length) ir.chapters = [{ title: ir.title, html: '<p></p>' }];

  if (ir.images[0]) ir.cover = { mime: ir.images[0].mime, data: ir.images[0].data };
  ir.title = (ir.title || 'Untitled').trim();
  return ir;
}

function decodeText(buf: Buffer, encoding: string): string {
  try {
    return new TextDecoder(encoding === 'latin1' ? 'windows-1252' : 'utf-8').decode(buf);
  } catch {
    return buf.toString(encoding === 'latin1' ? 'latin1' : 'utf8');
  }
}

function stripMobiWrappers(html: string): string {
  return String(html || '')
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<\/?(html|head|body|guide|reference)[^>]*>/gi, '')
    .replace(/<a\b[^>]*\bfilepos=[^>]*>/gi, '')
    .replace(/<a\b[^>]*><\/a>/gi, '')
    .trim();
}

function imageMime(r: Buffer | undefined): string | null {
  if (!r || r.length < 4) return null;
  if (r[0] === 0xff && r[1] === 0xd8) return 'image/jpeg';
  if (r[0] === 0x89 && r[1] === 0x50 && r[2] === 0x4e && r[3] === 0x47) return 'image/png';
  if (r.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

// ---------------------------------------------------------------------------
// IR -> MOBI
// ---------------------------------------------------------------------------

const RECORD_SIZE = 4096;

export function irToMobi(ir: Ir): Buffer {
  // 1. build the single HTML blob
  const bodyParts = ir.chapters.map((ch, i: number) => {
    const heading = ch.title ? `<h2>${escapeXml(ch.title)}</h2>` : '';
    let html = sanitizeHtml(ch.html);
    // <img src="images/ID"> -> <img recindex="N">
    html = html.replace(/<img\b[^>]*\bsrc=["']images\/([^"']+)["'][^>]*>/gi, (_m, id: string) => {
      const idx = ir.images.findIndex((im) => im.id === id);
      return idx >= 0 ? `<img recindex="${String(idx + 1).padStart(5, '0')}"/>` : '';
    });
    return `${i > 0 ? '<mbp:pagebreak/>' : ''}${heading}${html}`;
  });

  const html =
    `<html><head><guide></guide></head><body>` +
    bodyParts.join('\n') +
    `</body></html>`;
  const textBuf = Buffer.from(html, 'utf8');

  // 2. split text into records
  const textRecords: Buffer[] = [];
  for (let off = 0; off < textBuf.length; off += RECORD_SIZE) {
    textRecords.push(textBuf.subarray(off, Math.min(off + RECORD_SIZE, textBuf.length)));
  }
  if (textRecords.length === 0) textRecords.push(Buffer.alloc(0));
  const numTextRecords = textRecords.length;

  // 3. image records
  const imageRecords = ir.images.map((im) => im.data);

  // 4. EXTH
  const exth = buildExth(ir);

  // 5. full name
  const fullName = Buffer.from(ir.title || 'Untitled', 'utf8');

  // 6. MOBI header (0xC8 = 200 bytes)
  const MOBI_HEADER_LEN = 0xc8;
  const mobi = Buffer.alloc(MOBI_HEADER_LEN);
  mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(MOBI_HEADER_LEN, 4); // header length
  mobi.writeUInt32BE(2, 8); // mobi type: 2 = book
  mobi.writeUInt32BE(65001, 12); // text encoding UTF-8
  mobi.writeUInt32BE(Math.floor(Math.random() * 0xffffffff), 16); // unique id
  mobi.writeUInt32BE(6, 20); // file version
  mobi.fill(0xff, 24, 0x44); // all index records absent (0x18..0x54 in record0)
  const firstImageIndex = 1 + numTextRecords; // record number where images begin
  // full name offset is relative to record0 start
  const palmDocHeaderLen = 16;
  const fullNameOffset = palmDocHeaderLen + MOBI_HEADER_LEN + exth.length;
  mobi.writeUInt32BE(fullNameOffset, 0x54 - 16); // 0x54 within record0 -> minus palmdoc header
  mobi.writeUInt32BE(fullName.length, 0x58 - 16);
  mobi.writeUInt32BE(0, 0x5c - 16); // locale
  mobi.writeUInt32BE(0, 0x60 - 16);
  mobi.writeUInt32BE(0, 0x64 - 16);
  mobi.writeUInt32BE(imageRecords.length ? firstImageIndex : 0xffffffff, 0x6c - 16); // first image index
  mobi.writeUInt32BE(0, 0x70 - 16); // huff record
  mobi.writeUInt32BE(0, 0x74 - 16);
  mobi.writeUInt32BE(0, 0x78 - 16);
  mobi.writeUInt32BE(0, 0x7c - 16);
  mobi.writeUInt32BE(0x40, 0x80 - 16); // EXTH flags: 0x40 = EXTH present
  mobi.fill(0, 0x84 - 16, 0xb0 - 16);
  mobi.writeUInt32BE(0xffffffff, 0xb0 - 16); // DRM offset = none
  mobi.writeUInt32BE(0, 0xb4 - 16);
  mobi.writeUInt32BE(0, 0xb8 - 16);
  mobi.writeUInt16BE(1, 0xc0 - 16); // first content record
  mobi.writeUInt16BE(
    numTextRecords + imageRecords.length,
    0xc2 - 16,
  ); // last content record
  mobi.writeUInt32BE(1, 0xc4 - 16); // FCIS/FLIS presence marker-ish

  // 7. PalmDOC header (16 bytes)
  const palmDoc = Buffer.alloc(16);
  palmDoc.writeUInt16BE(1, 0); // compression: 1 = none
  palmDoc.writeUInt16BE(0, 2);
  palmDoc.writeUInt32BE(textBuf.length, 4); // uncompressed text length
  palmDoc.writeUInt16BE(numTextRecords, 8);
  palmDoc.writeUInt16BE(RECORD_SIZE, 10);
  palmDoc.writeUInt16BE(0, 12); // encryption none
  palmDoc.writeUInt16BE(0, 14);

  const record0 = Buffer.concat([
    palmDoc,
    mobi,
    exth,
    fullName,
    Buffer.alloc(padTo4(fullNameOffset + fullName.length) - (fullNameOffset + fullName.length) + 4),
  ]);

  // 8. trailing records
  const flis = buildFlis();
  const fcis = buildFcis(textBuf.length);
  const eof = Buffer.from([0xe9, 0x8e, 0x0d, 0x0a]);

  const allRecords = [
    record0,
    ...textRecords,
    ...imageRecords,
    flis,
    fcis,
    eof,
  ];

  // 9. PalmDB header + record offset list
  return assemblePalmDb(ir.title || 'Untitled', allRecords);
}

function buildExth(ir: Ir): Buffer {
  const records: Buffer[] = [];
  const add = (type: number, str: string) => {
    const data = Buffer.from(str, 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32BE(type, 0);
    head.writeUInt32BE(8 + data.length, 4);
    records.push(Buffer.concat([head, data]));
  };
  for (const a of ir.authors.length ? ir.authors : ['Unknown']) add(100, a);
  add(503, ir.title || 'Untitled');
  if (ir.language) add(524, ir.language);
  add(104, ir.identifier); // isbn-ish slot, harmless
  const body = Buffer.concat(records);
  const header = Buffer.alloc(12);
  header.write('EXTH', 0, 'latin1');
  header.writeUInt32BE(12 + body.length, 4);
  header.writeUInt32BE(records.length, 8);
  let exth = Buffer.concat([header, body]);
  const pad = (4 - (exth.length % 4)) % 4;
  if (pad) exth = Buffer.concat([exth, Buffer.alloc(pad)]);
  return exth;
}

function buildFlis(): Buffer {
  const b = Buffer.alloc(36);
  b.write('FLIS', 0, 'latin1');
  b.writeUInt32BE(8, 4);
  b.writeUInt16BE(65, 8);
  b.writeUInt16BE(0, 10);
  b.writeUInt32BE(0, 12);
  b.writeUInt32BE(0xffffffff, 16);
  b.writeUInt16BE(1, 20);
  b.writeUInt16BE(3, 22);
  b.writeUInt32BE(3, 24);
  b.writeUInt32BE(1, 28);
  b.writeUInt32BE(0xffffffff, 32);
  return b;
}

function buildFcis(textLength: number): Buffer {
  const b = Buffer.alloc(44);
  b.write('FCIS', 0, 'latin1');
  b.writeUInt32BE(20, 4);
  b.writeUInt32BE(16, 8);
  b.writeUInt32BE(1, 12);
  b.writeUInt32BE(0, 16);
  b.writeUInt32BE(textLength, 20);
  b.writeUInt32BE(0, 24);
  b.writeUInt32BE(32, 28);
  b.writeUInt32BE(8, 32);
  b.writeUInt16BE(1, 36);
  b.writeUInt16BE(1, 38);
  b.writeUInt32BE(0, 40);
  return b;
}

function assemblePalmDb(title: string, records: Buffer[]): Buffer {
  const name = Buffer.alloc(32);
  Buffer.from(sanitizeDbName(title), 'latin1').copy(name, 0, 0, 31);
  const numRecords = records.length;
  const headerLen = 78 + numRecords * 8 + 2; // + 2 gap bytes before first record
  const head = Buffer.alloc(78);
  name.copy(head, 0);
  head.writeUInt16BE(0, 32); // attributes
  head.writeUInt16BE(0, 34); // version
  const now = Math.floor(Date.now() / 1000) + 2082844800; // Mac epoch
  head.writeUInt32BE(now, 36);
  head.writeUInt32BE(now, 40);
  head.writeUInt32BE(0, 44);
  head.writeUInt32BE(0, 48);
  head.writeUInt32BE(0, 52);
  head.writeUInt32BE(0, 56);
  head.write('BOOK', 60, 'latin1');
  head.write('MOBI', 64, 'latin1');
  head.writeUInt32BE(0, 68); // unique id seed
  head.writeUInt32BE(0, 72);
  head.writeUInt16BE(numRecords, 76);

  const recList = Buffer.alloc(numRecords * 8 + 2);
  let offset = headerLen;
  for (let i = 0; i < numRecords; i++) {
    recList.writeUInt32BE(offset, i * 8);
    recList.writeUInt8(0, i * 8 + 4);
    recList.writeUIntBE(i * 2, i * 8 + 5, 3); // unique id
    offset += records[i].length;
  }

  return Buffer.concat([head, recList, ...records]);
}

function sanitizeDbName(title: string): string {
  return (title || 'book')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .slice(0, 31)
    .replace(/ /g, '_') || 'book';
}

function padTo4(n: number): number {
  return n + ((4 - (n % 4)) % 4);
}
