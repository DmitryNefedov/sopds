import { sniffMime } from './fb2.js';
import { getLangCode } from '../lang.js';
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
    if (buf.length < 78 || buf.toString('latin1', 60, 64) !== 'BOOK') return meta as RawMeta;
    const numRecords = buf.readUInt16BE(76);
    const rec0Start = buf.readUInt32BE(78);
    const rec0End = numRecords > 1 ? buf.readUInt32BE(86) : buf.length;
    const rec0 = buf.subarray(rec0Start, rec0End);
    if (rec0.toString('latin1', 16, 20) !== 'MOBI') return meta as RawMeta;

    const mobiHeaderLen = rec0.readUInt32BE(20);
    const textEncoding = rec0.readUInt32BE(28);
    const enc = textEncoding === 1252 ? 'windows-1252' : 'utf-8';
    const dec = (b: Buffer) => {
      try {
        return new TextDecoder(enc, { fatal: false }).decode(b).trim();
      } catch {
        return b.toString('utf8').trim();
      }
    };

    const fullNameOffset = rec0.readUInt32BE(0x54);
    const fullNameLength = rec0.readUInt32BE(0x58);
    if (fullNameOffset && fullNameOffset + fullNameLength <= rec0.length) {
      meta.title = dec(rec0.subarray(fullNameOffset, fullNameOffset + fullNameLength));
    }

    const exthFlags = rec0.readUInt32BE(0x80);
    if (exthFlags & 0x40) {
      const start = 16 + mobiHeaderLen;
      if (rec0.toString('latin1', start, start + 4) === 'EXTH') {
        const count = rec0.readUInt32BE(start + 8);
        let p = start + 12;
        const seriesName: { n: string | null; idx: number | null } = { n: null, idx: null };
        for (let i = 0; i < count && p + 8 <= rec0.length; i++) {
          const type = rec0.readUInt32BE(p);
          const size = rec0.readUInt32BE(p + 4);
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
    if (buf.length < 78 || buf.toString('latin1', 60, 68) !== 'BOOKMOBI') {
      if (buf.toString('latin1', 60, 64) !== 'BOOK') return null;
    }
    const numRecords = buf.readUInt16BE(76);
    if (!numRecords) return null;
    const offsets: number[] = [];
    for (let i = 0; i < numRecords; i++) {
      offsets.push(buf.readUInt32BE(78 + i * 8));
    }
    offsets.push(buf.length);

    const rec0 = buf.subarray(offsets[0], offsets[1]);
    if (rec0.toString('latin1', 16, 20) !== 'MOBI') return firstImage(buf, offsets, 1);

    const mobiHeaderLen = rec0.readUInt32BE(20);
    const firstImageIndex = rec0.readUInt32BE(0x6c);
    const exthFlags = rec0.readUInt32BE(0x80);

    let coverOffset: number | null = null;
    let thumbOffset: number | null = null;
    if (exthFlags & 0x40) {
      const start = 16 + mobiHeaderLen;
      if (rec0.toString('latin1', start, start + 4) === 'EXTH') {
        const count = rec0.readUInt32BE(start + 8);
        let p = start + 12;
        for (let i = 0; i < count && p + 8 <= rec0.length; i++) {
          const type = rec0.readUInt32BE(p);
          const size = rec0.readUInt32BE(p + 4);
          if (size < 8) break;
          if (type === 201) coverOffset = rec0.readUInt32BE(p + 8);
          else if (type === 202) thumbOffset = rec0.readUInt32BE(p + 8);
          p += size;
        }
      }
    }

    const base = firstImageIndex > 0 && firstImageIndex < numRecords ? firstImageIndex : null;

    const tryRecord = (recNo: number | null): CoverImage | null => {
      if (recNo == null || recNo < 0 || recNo >= numRecords) return null;
      const r = buf.subarray(offsets[recNo], offsets[recNo + 1]);
      const mime = sniffMime(r);
      return mime ? { data: Buffer.from(r), mime } : null;
    };

    if (base != null && coverOffset != null && coverOffset !== 0xffffffff) {
      const hit = tryRecord(base + coverOffset);
      if (hit) return hit;
    }
    if (base != null && thumbOffset != null && thumbOffset !== 0xffffffff) {
      const hit = tryRecord(base + thumbOffset);
      if (hit) return hit;
    }
    return firstImage(buf, offsets, base ?? 1);
  } catch {
    return null;
  }
}

function firstImage(buf: Buffer, offsets: number[], start: number): CoverImage | null {
  for (let i = start; i < offsets.length - 1; i++) {
    const r = buf.subarray(offsets[i], offsets[i + 1]);
    if (r.toString('latin1', 0, 4) === 'FLIS' || r.toString('latin1', 0, 4) === 'FCIS') break;
    const mime = sniffMime(r);
    if (mime) return { data: Buffer.from(r), mime };
  }
  return null;
}
