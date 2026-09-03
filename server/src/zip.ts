import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

// Streaming .zip access for the book collection.
//
// The collection can be hundreds of GB of `.zip` archives holding ~700k books.
// We never expand an archive to disk and never hold a whole archive in memory:
// yauzl opens the archive with a file descriptor, reads its central directory,
// and streams one entry at a time on demand. The scanner therefore keeps at
// most a single book in RAM regardless of how large the archive is.

export interface ZipEntry {
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
   * (much larger) body and embedded cover — see `books/parseBook`.
   */
  readHead(limit: number, stopAt?: Buffer): Promise<Buffer>;
}

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
    zf.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('cannot read archive entry'));
      const chunks: Buffer[] = [];
      let len = 0;
      let searched = 0; // bytes of `chunks` already scanned for `stopAt`
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
        if (stopAt) {
          // Re-scan from just before the previous end so a marker straddling
          // two chunks is not missed.
          const from = Math.max(0, searched - stopAt.length + 1);
          const hay = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
          if (hay.indexOf(stopAt, from) >= 0) return finish();
          searched = len;
        }
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
  });
}

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

/**
 * Iterate the file entries of a `.zip`. Directories are skipped. Each entry's
 * bytes are read only when `read()` / `readHead()` is awaited, and only one at
 * a time.
 */
export async function* zipEntries(archivePath: string): AsyncGenerator<ZipEntry> {
  const zf = await openZip(archivePath);
  try {
    for (let entry = await nextEntry(zf); entry; entry = await nextEntry(zf)) {
      if (/\/$/.test(entry.fileName)) continue; // directory entry
      const current = entry;
      yield {
        name: current.fileName,
        size: current.uncompressedSize,
        read: () => entryBuffer(zf, current),
        readHead: (limit, stopAt) => entryHead(zf, current, limit, stopAt),
      };
    }
  } finally {
    zf.close();
  }
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
    zf.close();
  }
}
