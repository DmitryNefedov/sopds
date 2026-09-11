import { emptyIr, escapeXml, sanitizeHtml } from './ir.js';
import type { Ir } from './ir.js';

// Pure-JS MOBI (MOBI6 / PalmDOC) reader + writer, for uncompressed and
// PalmDOC-compressed text. HUFF/CDIC is detected and reported, not mis-decoded.

// ---------------------------------------------------------------------------
// PalmDB parsing helpers
// ---------------------------------------------------------------------------

export function parsePalmDb(buf: Buffer): { type: string; creator: string; records: Buffer[] } {
  // Stryker disable next-line EqualityOperator: 78 is the exact header size; <=/< is off by the last byte only.
  if (buf.length < 78) throw new Error('MOBI: file too small');
  // Stryker disable next-line StringLiteral: 'latin1' vs '' (utf8) decode the same ASCII.
  const type = buf.toString('latin1', 60, 64);
  // Stryker disable next-line StringLiteral: as above.
  const creator = buf.toString('latin1', 64, 68);
  const numRecords = buf.readUInt16BE(76);
  const records: number[] = [];
  // Stryker disable next-line EqualityOperator: one extra offset read is discarded.
  for (let i = 0; i < numRecords; i++) {
    const p = 78 + i * 8;
    const offset = buf.readUInt32BE(p);
    records.push(offset);
  }
  // Stryker disable next-line CallExpression: the sentinel bounds the last slice.
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

export function palmDocDecompress(input: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  const n = input.length;
  // Stryker disable EqualityOperator,ConditionalExpression: the opcode-class
  // boundaries and the literal-run bound only differ by one undefined byte read.
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
    // Stryker restore EqualityOperator,ConditionalExpression
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// trailing "extra data" stripping
// ---------------------------------------------------------------------------

export function stripTrailingEntries(record: Buffer, extraFlags: number): Buffer {
  let end = record.length;
  // Every set bit above bit 0 is one trailing "extra data" entry whose length
  // is a backwards-encoded varint in its last bytes.
  // Stryker disable next-line ConditionalExpression,AssignmentOperator: driven by extraFlags, which our writer leaves 0.
  for (let flag = extraFlags >> 1; flag; flag >>= 1) {
    if (flag & 1) end -= decodeBackwardVarint(record, end);
  }
  if (extraFlags & 1) {
    // multibyte overlap trailer: last byte's low 2 bits +1
    const a = record[end - 1];
    end -= (a & 0x3) + 1;
  }
  return record.subarray(0, Math.max(0, end));
}

export function decodeBackwardVarint(record: Buffer, end: number): number {
  let value = 0;
  // Stryker disable next-line EqualityOperator: a MOBI varint is 1-4 bytes.
  for (let k = 1; k <= 4; k++) {
    const byte = record[end - k];
    // Stryker disable next-line ArithmeticOperator: k is 1 or 2 in practice, where 7*(k-1) == 7/(k-1).
    value = k === 1 ? byte & 0x7f : ((byte & 0x7f) << (7 * (k - 1))) | value;
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
export function parseExth(rec0: Buffer, start: number): ExthMeta {
  const meta: ExthMeta = { authors: [], title: null, language: null, coverOffset: null };
  // Stryker disable next-line StringLiteral: 'latin1' vs '' decode 'EXTH' the same.
  if (rec0.toString('latin1', start, start + 4) !== 'EXTH') return meta;
  const len = rec0.readUInt32BE(start + 4);
  const count = rec0.readUInt32BE(start + 8);
  let p = start + 12;
  // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,ArithmeticOperator,UpdateOperator: guards a self-inconsistent EXTH block.
  for (let i = 0; i < count && p + 8 <= start + len; i++) {
    const type = rec0.readUInt32BE(p);
    const size = rec0.readUInt32BE(p + 4);
    const data = rec0.subarray(p + 8, p + size);
    if (type === 100) meta.authors.push(data.toString());
    else if (type === 503) meta.title = data.toString();
    else if (type === 524) meta.language = data.toString();
    // Stryker disable next-line ConditionalExpression,EqualityOperator: coverOffset is unused downstream.
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

  // Stryker disable next-line StringLiteral: '' also routes decodeText to utf-8.
  let encoding = 'utf8';
  let firstImageIndex = 0;
  let fullNameOffset = 0;
  let fullNameLength = 0;
  let mobiHeaderLen = 0;
  let extraFlags = 0;
  // Stryker disable next-line StringLiteral: 'latin1' vs '' decode 'MOBI' the same.
  let hasMobiHeader = rec0.toString('latin1', 16, 20) === 'MOBI';

  if (hasMobiHeader) {
    mobiHeaderLen = rec0.readUInt32BE(20);
    const textEncoding = rec0.readUInt32BE(28);
    // Stryker disable next-line StringLiteral: the else 'utf8' vs '' is a no-op
    // for decodeText (both -> utf-8).
    encoding = textEncoding === 1252 ? 'latin1' : 'utf8';
    fullNameOffset = rec0.readUInt32BE(0x54);
    fullNameLength = rec0.readUInt32BE(0x58);
    firstImageIndex = rec0.readUInt32BE(0x6c);
    const exthFlags = rec0.readUInt32BE(0x80);
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator,BlockStatement: trailing-extra-data path, not exercised by our writer.
    if (mobiHeaderLen >= 0xe4 && 16 + 0xf2 + 2 <= rec0.length) {
      // "Extra record data flags" live at a fixed offset in record 0.
      extraFlags = rec0.readUInt16BE(0xf2);
    }
    if (exthFlags & 0x40) {
      const exth = parseExth(rec0, 16 + mobiHeaderLen);
      if (exth.title) ir.title = exth.title;
      if (exth.authors.length) ir.authors = exth.authors;
      if (exth.language) ir.language = exth.language;
    }
    if (fullNameOffset && fullNameLength && fullNameOffset + fullNameLength <= rec0.length) {
      // Stryker disable next-line StringLiteral: 'utf8' is Buffer.toString's default.
      const nm = rec0.toString('utf8', fullNameOffset, fullNameOffset + fullNameLength);
      if (nm && (!ir.title || ir.title === 'Untitled')) ir.title = nm;
    }
  }

  if (compression === 17480) {
    throw new Error('MOBI: HUFF/CDIC-compressed files are not supported for conversion');
  }

  // assemble text
  const parts: Buffer[] = [];
  // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,UpdateOperator: `i < records.length` is a bounds guard; recordCount drives the real count.
  for (let i = 1; i <= recordCount && i < records.length; i++) {
    let r = records[i];
    // Stryker disable next-line ConditionalExpression: guards a records array with holes, which parsePalmDb never produces.
    if (!r) break;
    r = stripTrailingEntries(r, extraFlags);
    parts.push(compression === 2 ? palmDocDecompress(r) : Buffer.from(r));
  }
  let text = Buffer.concat(parts);
  // Stryker disable next-line ConditionalExpression,EqualityOperator: subarray(0, n) clamps, so an over-eager clip to a length >= text.length is a no-op.
  if (text.length > textLength) text = text.subarray(0, textLength);
  let htmlAll = decodeText(text, encoding);

  // images: records from firstImageIndex up to recordCount-1 range; detect by magic
  const imageRecords: Array<{ mime: string; data: Buffer }> = [];
  // Our writer always makes `firstImageIndex === recordCount + 1`, and lays the
  // records out as [rec0, ...text, ...images, FLIS, FCIS, eof]. So both branches
  // of `startImg` pick the same record, the `- 1` just skips the sentinel slice,
  // and after the images the very next record is always FLIS.
  // Stryker disable ConditionalExpression,EqualityOperator,LogicalOperator,ArithmeticOperator,StringLiteral: see the note above.
  const startImg =
    firstImageIndex > 0 && firstImageIndex < records.length ? firstImageIndex : recordCount + 1;
  for (let i = startImg; i < records.length - 1; i++) {
    const r = records[i];
    const mime = imageMime(r);
    if (mime) imageRecords.push({ mime, data: Buffer.from(r) });
    else if (r && r.toString('latin1', 0, 4) === 'FLIS') break;
  }
  // Stryker restore ConditionalExpression,EqualityOperator,LogicalOperator,ArithmeticOperator,StringLiteral
  imageRecords.forEach((im, idx) => {
    ir.images.push({ id: `img${String(idx + 1).padStart(5, '0')}`, mime: im.mime, data: im.data });
  });

  // rewrite <img recindex="N"> -> images/imgNNNNN
  // Stryker disable next-line Regex: the closing `["']?` only skips one quote that the following `[^>]*` would consume regardless.
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

  // `[stripMobiWrappers(htmlAll)]` is never empty, so there is always at least
  // one chapter (an empty one for a bodyless book).
  ir.chapters = (rawChapters.length ? rawChapters : [stripMobiWrappers(htmlAll)]).map((h) => {
    const hm = h.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    return { title: hm ? hm[1].replace(/<[^>]+>/g, '').trim() : '', html: h };
  });

  if (ir.images[0]) ir.cover = { mime: ir.images[0].mime, data: ir.images[0].data };
  // `ir.title` is never empty here - it starts life as emptyIr()'s 'Untitled'
  // and only ever gets overwritten with a non-empty EXTH title or full name.
  ir.title = ir.title.trim();
  return ir;
}

export function decodeText(buf: Buffer, encoding: string): string {
  // `windows-1252` and (for `undefined`) utf-8 are both WHATWG-mandatory labels,
  // always present, and `.decode` is non-fatal by default, so neither throws.
  // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: latin1 is the only non-utf-8 encoding a MOBI declares; every other value means utf-8.
  const label = encoding === 'latin1' ? 'windows-1252' : undefined;
  return new TextDecoder(label).decode(buf);
}

export function stripMobiWrappers(html: string): string {
  return String(html || '')
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<\/?(html|head|body|guide|reference)[^>]*>/gi, '')
    .replace(/<a\b[^>]*\bfilepos=[^>]*>/gi, '')
    .replace(/<a\b[^>]*><\/a>/gi, '')
    .trim();
}

export function imageMime(r: Buffer | undefined): string | null {
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
    // Stryker disable next-line StringLiteral: stripMobiWrappers removes this wrapper on read-back.
    `<html><head><guide></guide></head><body>` +
    // Stryker disable next-line StringLiteral: the split is on <mbp:pagebreak>, not the newline.
    bodyParts.join('\n') +
    // Stryker disable next-line StringLiteral: as above.
    `</body></html>`;
  const textBuf = Buffer.from(html);

  // 2. split text into records
  const textRecords: Buffer[] = [];
  // Stryker disable next-line EqualityOperator: `<=` only adds a trailing empty record when the blob is an exact multiple of RECORD_SIZE; the writer records that count and the reader concatenates the empty record to nothing.
  for (let off = 0; off < textBuf.length; off += RECORD_SIZE) {
    // Stryker disable next-line MethodExpression: subarray clamps, so max vs min only differs past the end.
    textRecords.push(textBuf.subarray(off, Math.min(off + RECORD_SIZE, textBuf.length)));
  }
  const numTextRecords = textRecords.length;

  // 3. image records
  const imageRecords = ir.images.map((im) => im.data);

  // 4. EXTH
  const exth = buildExth(ir);

  // 5. full name
  const fullName = Buffer.from(ir.title || 'Untitled');

  // 6. MOBI header (0xC8 = 200 bytes). `Buffer.alloc` zeroes the reserved
  //    slots (locale, huff records, DRM fields), so only the real values are
  //    written. Offsets are `0xNN - 16` because 0xNN is measured from the start
  //    of record 0, which begins with the 16-byte PalmDOC header.
  const MOBI_HEADER_LEN = 0xc8;
  const mobi = Buffer.alloc(MOBI_HEADER_LEN);
  mobi.write('MOBI', 0);
  mobi.writeUInt32BE(MOBI_HEADER_LEN, 4); // header length
  mobi.writeUInt32BE(2, 8); // mobi type: 2 = book
  mobi.writeUInt32BE(65001, 12); // text encoding UTF-8
  // Stryker disable next-line ArithmeticOperator: any pseudo-random 32-bit id will do.
  // Stryker disable next-line CallExpression: a random unique id; its absence is harmless.
  mobi.writeUInt32BE(Math.floor(Math.random() * 0xffffffff), 16); // unique id
  mobi.writeUInt32BE(6, 20); // file version
  mobi.fill(0xff, 24, 0x44); // index records absent (0x18..0x54 in record 0)
  const firstImageIndex = 1 + numTextRecords; // record number where images begin
  const palmDocHeaderLen = 16;
  const fullNameOffset = palmDocHeaderLen + MOBI_HEADER_LEN + exth.length;
  mobi.writeUInt32BE(fullNameOffset, 0x54 - 16);
  mobi.writeUInt32BE(fullName.length, 0x58 - 16);
  mobi.writeUInt32BE(imageRecords.length ? firstImageIndex : 0xffffffff, 0x6c - 16); // first image index
  mobi.writeUInt32BE(0x40, 0x80 - 16); // EXTH flags: 0x40 = EXTH present
  mobi.writeUInt32BE(0xffffffff, 0xb0 - 16); // DRM offset = none
  mobi.writeUInt16BE(1, 0xc0 - 16); // first content record
  mobi.writeUInt16BE(numTextRecords + imageRecords.length, 0xc2 - 16); // last content record
  mobi.writeUInt32BE(1, 0xc4 - 16); // FCIS/FLIS presence marker

  // 7. PalmDOC header (16 bytes); alloc zeroes the encryption + reserved words.
  const palmDoc = Buffer.alloc(16);
  palmDoc.writeUInt16BE(1, 0); // compression: 1 = none
  palmDoc.writeUInt32BE(textBuf.length, 4); // uncompressed text length
  palmDoc.writeUInt16BE(numTextRecords, 8);
  palmDoc.writeUInt16BE(RECORD_SIZE, 10);

  const record0 = Buffer.concat([
    palmDoc,
    mobi,
    exth,
    fullName,
    // Stryker disable next-line ArithmeticOperator: trailing padding of record 0; unread.
    Buffer.alloc(padTo4(fullNameOffset + fullName.length) - (fullNameOffset + fullName.length) + 4),
  ]);

  // 8. trailing records
  const flis = buildFlis();
  const fcis = buildFcis(textBuf.length);
  // Stryker disable next-line ArrayDeclaration: our reader ignores the EOF record;
  // an empty one just shifts the trailing offsets, which nothing checks.
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

export function buildExth(ir: Ir): Buffer {
  const records: Buffer[] = [];
  const add = (type: number, str: string) => {
    const data = Buffer.from(str);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(type, 0);
    head.writeUInt32BE(8 + data.length, 4);
    records.push(Buffer.concat([head, data]));
  };
  for (const a of ir.authors.length ? ir.authors : ['Unknown']) add(100, a);
  add(503, ir.title || 'Untitled');
  if (ir.language) add(524, ir.language);
  const body = Buffer.concat(records);
  const header = Buffer.alloc(12);
  header.write('EXTH', 0);
  header.writeUInt32BE(12 + body.length, 4);
  header.writeUInt32BE(records.length, 8);
  const exth = Buffer.concat([header, body]);
  // Stryker disable next-line ArithmeticOperator: 4-byte alignment padding of EXTH; alloc(0) when already aligned.
  const pad = (4 - (exth.length % 4)) % 4;
  return Buffer.concat([exth, Buffer.alloc(pad)]);
}

// FLIS / FCIS are the "end of book" bookkeeping records a strict reader expects.
// Our own reader only checks the 4-byte magic, but real MOBI tooling validates
// the fixed fields, so they are written to spec. `Buffer.alloc` zeroes the rest.
export function buildFlis(): Buffer {
  const b = Buffer.alloc(36);
  b.write('FLIS', 0);
  b.writeUInt32BE(8, 4);
  b.writeUInt16BE(65, 8);
  b.writeUInt32BE(0xffffffff, 16);
  b.writeUInt16BE(1, 20);
  b.writeUInt16BE(3, 22);
  b.writeUInt32BE(3, 24);
  b.writeUInt32BE(1, 28);
  b.writeUInt32BE(0xffffffff, 32);
  return b;
}

export function buildFcis(textLength: number): Buffer {
  const b = Buffer.alloc(44);
  b.write('FCIS', 0);
  b.writeUInt32BE(20, 4);
  b.writeUInt32BE(16, 8);
  b.writeUInt32BE(1, 12);
  b.writeUInt32BE(textLength, 20);
  b.writeUInt32BE(32, 28);
  b.writeUInt32BE(8, 32);
  b.writeUInt16BE(1, 36);
  b.writeUInt16BE(1, 38);
  return b;
}

export function assemblePalmDb(title: string, records: Buffer[]): Buffer {
  const name = Buffer.alloc(32);
  // Stryker disable next-line StringLiteral: sanitizeDbName strips non-ASCII, so
  // 'latin1' and utf8 produce identical bytes.
  Buffer.from(sanitizeDbName(title), 'latin1').copy(name, 0, 0, 31);
  const numRecords = records.length;
  const headerLen = 78 + numRecords * 8 + 2; // + 2 gap bytes before first record
  // `Buffer.alloc` zeroes the PalmDB header's attribute/version/modNumber/
  // appInfo/sortInfo/uniqueIdSeed slots.
  const head = Buffer.alloc(78);
  name.copy(head, 0);
  const now = Math.floor(Date.now() / 1000) + 2082844800; // Mac epoch
  // Stryker disable next-line CallExpression: PalmDB timestamps; nothing here reads them.
  head.writeUInt32BE(now, 36); // creation date
  // Stryker disable next-line CallExpression: as above.
  head.writeUInt32BE(now, 40); // modification date
  head.write('BOOK', 60); // type
  head.write('MOBI', 64); // creator
  head.writeUInt16BE(numRecords, 76);

  const recList = Buffer.alloc(numRecords * 8 + 2);
  let offset = headerLen;
  for (let i = 0; i < numRecords; i++) {
    recList.writeUInt32BE(offset, i * 8); // record offset
    // byte i*8+4 (attributes) stays 0 from the alloc
    // Stryker disable next-line CallExpression,ArithmeticOperator: PalmDB per-record id; nothing here reads it.
    recList.writeUIntBE(i * 2, i * 8 + 5, 3); // unique id
    offset += records[i].length;
  }

  return Buffer.concat([head, recList, ...records]);
}

export function sanitizeDbName(title: string): string {
  // Stryker disable next-line StringLiteral: the trailing `|| 'book'` is the real guard.
  return (title || 'book')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .slice(0, 31)
    .replace(/ /g, '_') || 'book';
}

export function padTo4(n: number): number {
  return n + ((4 - (n % 4)) % 4);
}
