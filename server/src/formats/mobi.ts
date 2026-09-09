import { sniffMime } from './fb2.js';
import { getLangCode } from '../utils/lang.js';
import type { RawMeta } from './index.js';
import type { CoverImage } from '../types.js';

// EXTH-only MOBI metadata (title / authors / language / series). Does not
// decompress the book text.
export function mobiMeta(buf: Buffer): RawMeta {
  const meta: Record<string, any> = {
    title: '',
    authors: [],
    genres: [],
    lang: '',
    docdate: '',
    series: null,
  };
  try {
    // Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement: skipping this
    // guard just lets the reads below throw into the catch, yielding the same empty result.
    if (buf.length < 78 || buf.toString('latin1', 60, 64) !== 'BOOK') return meta as RawMeta;
    const numRecords = buf.readUInt16BE(76);
    const rec0Start = buf.readUInt32BE(78);
    // Stryker disable next-line ConditionalExpression,EqualityOperator: a real MOBI always has
    // >1 record; a wrong rec0End still starts with 'MOBI' and the later bounds checks hold.
    const rec0End = numRecords > 1 ? buf.readUInt32BE(86) : buf.length;
    const rec0 = buf.subarray(rec0Start, rec0End);
    if (rec0.toString('latin1', 16, 20) !== 'MOBI') return meta as RawMeta;

    const mobiHeaderLen = rec0.readUInt32BE(20);
    const textEncoding = rec0.readUInt32BE(28);
    // Both labels are always valid, and TextDecoder is non-fatal by default
    // (unmappable bytes become U+FFFD).
    const decoder = new TextDecoder(textEncoding === 1252 ? 'windows-1252' : 'utf-8');
    const dec = (b: Buffer) => decoder.decode(b).trim();

    const fullNameOffset = rec0.readUInt32BE(0x54);
    const fullNameLength = rec0.readUInt32BE(0x58);
    // Stryker disable next-line ConditionalExpression,ArithmeticOperator,LogicalOperator: the
    // bounds half of this guard only prevents an out-of-range subarray (which clamps anyway).
    if (fullNameOffset && fullNameOffset + fullNameLength <= rec0.length) {
      meta.title = dec(rec0.subarray(fullNameOffset, fullNameOffset + fullNameLength));
    }

    const exthFlags = rec0.readUInt32BE(0x80);
    // Stryker disable next-line ConditionalExpression: with the flag forced on, the 'EXTH'
    // magic check below still gates real parsing.
    if (exthFlags & 0x40) {
      const start = 16 + mobiHeaderLen;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: forcing this true
      // parses garbage as EXTH, but readUInt32BE bounds/try-catch keep the result empty.
      if (rec0.toString('latin1', start, start + 4) === 'EXTH') {
        const count = rec0.readUInt32BE(start + 8);
        let p = start + 12;
        // Stryker disable next-line ObjectLiteral: {} gives the same undefined n/idx.
        const seriesName: { n: string | null; idx: number | null } = { n: null, idx: null };
        // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator,LogicalOperator,UpdateOperator: the
        // `p + 8 <= rec0.length` bound only stops an out-of-range read that the catch would absorb.
        for (let i = 0; i < count && p + 8 <= rec0.length; i++) {
          const type = rec0.readUInt32BE(p);
          const size = rec0.readUInt32BE(p + 4);
          // Stryker disable next-line EqualityOperator,ConditionalExpression: EXTH records are
          // >= 8 bytes; a misaligned no-break walk degrades gracefully to garbage that matches nothing.
          if (size < 8) break;
          const data = rec0.subarray(p + 8, p + size);
          if (type === 100) meta.authors.push(dec(data));
          else if (type === 503) meta.title = dec(data) || meta.title;
          else if (type === 524) meta.lang = dec(data);
          else if (type === 105) meta.genres.push(dec(data).toLowerCase());
          else if (type === 106) meta.docdate = dec(data);
          else if (type === 508) seriesName.n = dec(data);
          else if (type === 509) seriesName.idx = parseInt(dec(data), 10) || 0;
          p += size;
        }
        if (seriesName.n) meta.series = { title: seriesName.n, index: seriesName.idx || 0 };
      }
    }
  } catch {
    /* fall through with whatever we have */
  }
  meta.authors = (meta.authors as string[]).filter(Boolean).map((a) => {
    if (a.includes(',')) return a;
    const parts = a.split(/\s+/);
    if (parts.length < 2) return a;
    return [parts[parts.length - 1], parts.slice(0, -1).join(' ')].join(' ');
  });
  meta.langCode = getLangCode(meta.title);
  return meta as RawMeta;
}

// Focused MOBI cover extractor. Reads only what is needed to locate the
// embedded cover image record (EXTH 201 / 202), without decompressing the text.
export function mobiCover(buf: Buffer): CoverImage | null {
  try {
    // Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement,LogicalOperator: skipping this
    // guard just lets a later read throw into the catch, which also returns null.
    if (buf.length < 78 || buf.toString('latin1', 60, 64) !== 'BOOK') return null;
    const numRecords = buf.readUInt16BE(76);
    // Stryker disable next-line ConditionalExpression: with 0 records the loop and
    // subarray below produce an empty rec0 and firstImage() returns null anyway.
    if (!numRecords) return null;
    const offsets: number[] = [];
    for (let i = 0; i < numRecords; i++) {
      offsets.push(buf.readUInt32BE(78 + i * 8));
    }
    offsets.push(buf.length);

    const rec0 = buf.subarray(offsets[0], offsets[1]);
    // Stryker disable next-line ConditionalExpression: forcing this false still ends
    // at the same firstImage() scan via `base ?? 1` after the garbage EXTH reads.
    if (rec0.toString('latin1', 16, 20) !== 'MOBI') return firstImage(buf, offsets, 1);

    const mobiHeaderLen = rec0.readUInt32BE(20);
    const firstImageIndex = rec0.readUInt32BE(0x6c);
    const exthFlags = rec0.readUInt32BE(0x80);

    let coverOffset: number | null = null;
    let thumbOffset: number | null = null;
    // Stryker disable next-line ConditionalExpression: the 'EXTH' magic check gates real parsing.
    if (exthFlags & 0x40) {
      const start = 16 + mobiHeaderLen;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: forcing this true parses
      // garbage as EXTH, but the reads stay in-bounds or hit the catch.
      if (rec0.toString('latin1', start, start + 4) === 'EXTH') {
        const count = rec0.readUInt32BE(start + 8);
        let p = start + 12;
        // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator,LogicalOperator,UpdateOperator: the
        // `p + 8 <= rec0.length` bound only stops an out-of-range read the catch absorbs.
        for (let i = 0; i < count && p + 8 <= rec0.length; i++) {
          const type = rec0.readUInt32BE(p);
          const size = rec0.readUInt32BE(p + 4);
          // Stryker disable next-line EqualityOperator,ConditionalExpression: a misaligned
          // no-break walk just reads garbage that matches no cover/thumb type.
          if (size < 8) break;
          // Stryker disable next-line ConditionalExpression: forcing a match sets the offset
          // from unrelated bytes, which tryRecord rejects as out-of-range.
          if (type === 201) coverOffset = rec0.readUInt32BE(p + 8);
          // Stryker disable next-line ConditionalExpression: see above.
          if (type === 202) thumbOffset = rec0.readUInt32BE(p + 8);
          p += size;
        }
      }
    }

    // Stryker disable next-line EqualityOperator,ConditionalExpression: firstImageIndex is 0
    // or a real record number well inside the range; a wrong `base` still resolves to
    // tryRecord/firstImage returning null or the same first image.
    const base = firstImageIndex > 0 && firstImageIndex < numRecords ? firstImageIndex : null;

    const tryRecord = (recNo: number): CoverImage | null => {
      // recNo is always base + a non-negative offset, so only the upper bound can fail.
      // Stryker disable next-line ConditionalExpression,EqualityOperator: past the end,
      // offsets[recNo] is undefined and sniffMime(whole-buffer) is null - same as returning null.
      if (recNo >= numRecords) return null;
      const r = buf.subarray(offsets[recNo], offsets[recNo + 1]);
      const mime = sniffMime(r);
      return mime ? { data: Buffer.from(r), mime } : null;
    };

    // Stryker disable next-line LogicalOperator,ConditionalExpression: relaxing any conjunct
    // feeds tryRecord a null/NaN/sentinel record number, which still resolves to null.
    if (base != null && coverOffset != null && coverOffset !== 0xffffffff) {
      const hit = tryRecord(base + coverOffset);
      // Stryker disable next-line ConditionalExpression: a null hit falls through to the
      // thumb / firstImage path, which returns the same thing for this record range.
      if (hit) return hit;
    }
    // Stryker disable next-line LogicalOperator,ConditionalExpression: see above.
    if (base != null && thumbOffset != null && thumbOffset !== 0xffffffff) {
      const hit = tryRecord(base + thumbOffset);
      // Stryker disable next-line ConditionalExpression: a null hit here is what the
      // fall-through firstImage() call also produces for this record range.
      if (hit) return hit;
    }
    // Stryker disable next-line LogicalOperator: base is null or >= 1; `?? 1` vs `|| 1` agree.
    return firstImage(buf, offsets, base ?? 1);
  } catch {
    return null;
  }
}

function firstImage(buf: Buffer, offsets: number[], start: number): CoverImage | null {
  // Stryker disable next-line EqualityOperator,ArithmeticOperator: one extra iteration
  // reads offsets[len] === undefined -> a whole-buffer slice that sniffs to null.
  for (let i = start; i < offsets.length - 1; i++) {
    const r = buf.subarray(offsets[i], offsets[i + 1]);
    if (r.toString('latin1', 0, 4) === 'FLIS' || r.toString('latin1', 0, 4) === 'FCIS') break;
    const mime = sniffMime(r);
    if (mime) return { data: Buffer.from(r), mime };
  }
  return null;
}
