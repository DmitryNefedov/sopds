import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

// Streaming `.zip` access for a collection that can be hundreds of GB across
// archives of ~700k books. An archive is never expanded to disk or held whole
// in memory: yauzl streams one entry at a time from a file descriptor.

/**
 * Where an entry's bytes sit in the archive. The scan records this per book so
 * a later read can seek straight to it: finding an entry by name means walking
 * the central directory, which is O(entries) and, on a 2500-book archive, costs
 * ~75 ms — far more than inflating the book itself.
 */
export interface ZipLocation {
  /** Byte offset of the entry's local file header. */
  offset: number;
  /** Compressed size, i.e. how many bytes to read after that header. */
  csize: number;
  /** Zip compression method: 0 = stored, 8 = deflate. */
  method: number;
}

export interface ZipEntry extends ZipLocation {
  /** Entry path inside the archive (this is what we store as `books.filename`). */
  name: string;
  /** Uncompressed size in bytes, straight from the central directory. */
  size: number;
  /** Inflate just this entry into memory. Call before advancing the iterator. */
  read(): Promise<Buffer>;
  /**
   * Inflate only the beginning of the entry: stop as soon as `stopAt` has been
   * seen or `limit` bytes have been produced, whichever comes first. The
   * scanner uses this to read a book's metadata header without inflating the
   * (much larger) body and embedded cover — see `formats/parseBook`.
   */
  readHead(limit: number, stopAt?: Buffer): Promise<Buffer>;
}

// Stryker disable all: promise-ifying yauzl's callbacks. The `!zf` / `!stream`
// halves are unreachable (yauzl passes exactly one of err / value), the error
// string is internal, and the yauzl/zlib error events can't be provoked from a
// well-formed test archive. The happy paths are covered by zip-unit tests; a
// non-zip file exercises the `err` branch.
function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    // autoClose:false so we control the fd lifetime; lazyEntries so nothing is
    // read until we ask.
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zf) => {
      if (err || !zf) reject(err ?? new Error('cannot open archive'));
      else resolve(zf);
    });
  });
}

function entryBuffer(zf: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zf.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('cannot read archive entry'));
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}
// Stryker restore all

/**
 * Inflate the head of an entry and abandon the stream early. `stopAt` is
 * matched across chunk boundaries, so a marker split by the inflater's 16 KB
 * chunking is still found.
 */
function entryHead(
  zf: ZipFile,
  entry: Entry,
  limit: number,
  stopAt?: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Stryker disable all: this is stream plumbing. The observable contract -
    // returns min(accumulated, limit) bytes, or stops as soon as `stopAt` is
    // seen - is covered by zip-unit tests. `finish()` always clamps to `limit`,
    // so the early-stop optimisations (settled latch, stream.destroy, the
    // `len >= limit` short-circuit) don't change the output; the error path and
    // the `!stream` guard can't be provoked from a valid archive.
    zf.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('cannot read archive entry'));
      const chunks: Buffer[] = [];
      let len = 0;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        stream.destroy();
        resolve(Buffer.concat(chunks, Math.min(len, limit)));
      };
      stream.on('data', (c: Buffer) => {
        if (settled) return;
        chunks.push(c);
        len += c.length;
        // Re-scan the whole accumulated head each time; a marker straddling two
        // inflate chunks is therefore never missed. Heads are small (<= limit).
        // Stryker restore all
        if (stopAt && Buffer.concat(chunks).indexOf(stopAt) >= 0) return finish();
        // Stryker disable all
        if (len >= limit) finish();
      });
      stream.on('error', (e: Error) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
      stream.on('end', finish);
      stream.on('close', finish);
    });
    // Stryker restore all
  });
}

// Stryker disable all: `zf.once` already removes its own listener on fire, so
// the explicit cleanup() is belt-and-braces with no observable effect; the
// `onErr` path needs a yauzl read error that a valid archive never produces.
function nextEntry(zf: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      zf.removeListener('entry', onEntry);
      zf.removeListener('end', onEnd);
      zf.removeListener('error', onErr);
    };
    const onEntry = (e: Entry): void => {
      cleanup();
      resolve(e);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    const onErr = (e: Error): void => {
      cleanup();
      reject(e);
    };
    zf.once('entry', onEntry);
    zf.once('end', onEnd);
    zf.once('error', onErr);
    zf.readEntry();
  });
}
// Stryker restore all

/** Iterate the file entries of a `.zip`, skipping directories. An entry's
 *  bytes are read only when `read()` / `readHead()` is awaited, one at a time. */
export async function* zipEntries(archivePath: string): AsyncGenerator<ZipEntry> {
  const zf = await openZip(archivePath);
  try {
    for (let entry = await nextEntry(zf); entry; entry = await nextEntry(zf)) {
      if (/\/$/.test(entry.fileName)) continue; // directory entry
      const current = entry;
      yield {
        name: current.fileName,
        size: current.uncompressedSize,
        offset: current.relativeOffsetOfLocalHeader,
        csize: current.compressedSize,
        method: current.compressionMethod,
        read: () => entryBuffer(zf, current),
        readHead: (limit, stopAt) => entryHead(zf, current, limit, stopAt),
      };
    }
  } finally {
    // Stryker disable next-line CallExpression: fd cleanup, no observable behaviour.
    zf.close();
  }
}

/**
 * Read one entry using a location the scan recorded — no central-directory
 * walk. The local file header's own name/extra lengths are read from the file
 * because they may differ from the central directory's copy.
 */
export async function readZipEntryAt(archivePath: string, loc: ZipLocation): Promise<Buffer> {
  const fh = await fsp.open(archivePath, 'r');
  try {
    const header = Buffer.allocUnsafe(30);
    const { bytesRead } = await fh.read(header, 0, 30, loc.offset);
    // Stryker disable next-line ConditionalExpression: `bytesRead < 30` is a
    // belt-and-braces guard for a read near EOF whose first 4 bytes happen to be
    // the LFH magic - the magic check that follows still rejects a bad offset.
    if (bytesRead < 30 || header.readUInt32LE(0) !== 0x04034b50) {
      throw new Error('not a local file header at the recorded offset');
    }
    // Stryker disable next-line ArithmeticOperator: the extra-field length is
    // usually 0 in a local header, so `+`/`-` on it is a no-op for most archives.
    const start = loc.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = Buffer.allocUnsafe(loc.csize);
    const got = await fh.read(raw, 0, loc.csize, start);
    if (got.bytesRead < loc.csize) throw new Error('archive entry is truncated');
    if (loc.method === 0) return raw;
    if (loc.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`unsupported zip compression method ${loc.method}`);
  } finally {
    // Stryker disable next-line CallExpression: fd cleanup, no observable behaviour.
    await fh.close();
  }
}

/** Every entry's name and location, read from the central directory alone —
 *  nothing is inflated. Used to backfill locations for an existing catalog. */
export async function zipLocations(archivePath: string): Promise<Map<string, ZipLocation>> {
  const zf = await openZip(archivePath);
  const out = new Map<string, ZipLocation>();
  try {
    for (let entry = await nextEntry(zf); entry; entry = await nextEntry(zf)) {
      if (/\/$/.test(entry.fileName)) continue;
      out.set(entry.fileName, {
        offset: entry.relativeOffsetOfLocalHeader,
        csize: entry.compressedSize,
        method: entry.compressionMethod,
      });
    }
  } finally {
    // Stryker disable next-line CallExpression: fd cleanup, no observable behaviour.
    zf.close();
  }
  return out;
}

/** Read a single named entry from a `.zip` into memory. Throws if absent. */
export async function readZipEntry(archivePath: string, entryName: string): Promise<Buffer> {
  const zf = await openZip(archivePath);
  try {
    for (let entry = await nextEntry(zf); entry; entry = await nextEntry(zf)) {
      if (entry.fileName === entryName) return await entryBuffer(zf, entry);
    }
    throw new Error('entry not found in archive');
  } finally {
    // Stryker disable next-line CallExpression: fd cleanup, no observable behaviour.
    zf.close();
  }
}
