import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  zipEntries,
  readZipEntry,
  readZipEntryAt,
  zipLocations,
} from '../src/connectors/zip.js';

// The streaming .zip reader, exercised against real archives built with adm-zip.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-zip-'));

function makeZip(files: Record<string, Buffer | string>, opts: { compress?: boolean } = {}): string {
  const zip = new AdmZip();
  for (const [name, body] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(body) ? body : Buffer.from(body));
  }
  const p = path.join(tmp, `z-${Math.random().toString(36).slice(2)}.zip`);
  // adm-zip deflates by default; a directory entry is added explicitly.
  zip.writeZip(p);
  return p;
}

const BODY_A = Buffer.from('The quick brown fox '.repeat(50)); // compressible
const BODY_B = Buffer.from('second entry payload');

test('zipEntries yields every file entry, skipping directories', async () => {
  const z = new AdmZip();
  z.addFile('dir/', Buffer.alloc(0)); // explicit directory entry
  z.addFile('dir/a.txt', BODY_A);
  z.addFile('b.txt', BODY_B);
  const p = path.join(tmp, 'dirs.zip');
  z.writeZip(p);

  const names: string[] = [];
  for await (const e of zipEntries(p)) {
    names.push(e.name);
    assert.equal(typeof e.size, 'number');
    assert.equal(typeof e.offset, 'number');
  }
  assert.deepEqual(names.sort(), ['b.txt', 'dir/a.txt'], 'the "dir/" entry is skipped');
});

test('zipEntries.read() inflates one entry to its exact original bytes', async () => {
  const p = makeZip({ 'a.txt': BODY_A, 'b.txt': BODY_B });
  for await (const e of zipEntries(p)) {
    const bytes = await e.read();
    assert.ok(bytes.equals(e.name === 'a.txt' ? BODY_A : BODY_B), e.name);
  }
});

test('zipEntries.readHead() stops at a marker split across inflate chunks', async () => {
  // 40 KB of filler, then a marker, then more filler. The inflater chunks at
  // ~16 KB, so the marker lands mid-stream.
  const marker = Buffer.from('<<<STOP>>>');
  const body = Buffer.concat([Buffer.alloc(40_000, 0x41), marker, Buffer.alloc(40_000, 0x42)]);
  const p = makeZip({ 'big.bin': body });
  for await (const e of zipEntries(p)) {
    const head = await e.readHead(1_000_000, marker);
    assert.ok(head.includes(marker), 'the marker is present in the head');
    assert.ok(head.length >= 40_000 + marker.length, 'kept everything up to and including the marker');
    assert.ok(head.length < body.length - 20_000, 'stopped well before the end, not read whole');
  }
});

test('zipEntries.readHead() honours the byte limit when the marker is absent', async () => {
  const body = Buffer.alloc(100_000, 0x5a);
  const p = makeZip({ 'big.bin': body });
  for await (const e of zipEntries(p)) {
    const head = await e.readHead(25_000, Buffer.from('never-appears'));
    assert.equal(head.length, 25_000);
  }
});

test('zipEntries.readHead() with no marker returns min(limit, size)', async () => {
  const body = Buffer.from('short');
  const p = makeZip({ 's.txt': body });
  for await (const e of zipEntries(p)) {
    assert.equal((await e.readHead(1000)).toString(), 'short');
  }
});

test('zipEntries.readHead() stops immediately when the marker is at the very start', async () => {
  const marker = Buffer.from('MARK');
  const body = Buffer.concat([marker, Buffer.alloc(80_000, 0x43)]);
  const p = makeZip({ 'm.bin': body });
  for await (const e of zipEntries(p)) {
    const head = await e.readHead(1_000_000, marker);
    assert.ok(head.length < 40_000, `stopped near the start (got ${head.length})`);
    assert.ok(head.subarray(0, 4).equals(marker));
  }
});

test('readZipEntry finds an entry by name and throws when it is missing', async () => {
  const p = makeZip({ 'x/a.fb2': BODY_A, 'y/b.epub': BODY_B });
  assert.ok((await readZipEntry(p, 'y/b.epub')).equals(BODY_B));
  await assert.rejects(() => readZipEntry(p, 'nope.txt'), /entry not found/);
});

test('zipLocations maps every file entry to a seekable location, skipping directories', async () => {
  const z = new AdmZip();
  z.addFile('folder/', Buffer.alloc(0));
  z.addFile('folder/a.txt', BODY_A);
  z.addFile('b.txt', BODY_B);
  const p = path.join(tmp, 'loc-dirs.zip');
  z.writeZip(p);
  const locs = await zipLocations(p);
  assert.deepEqual([...locs.keys()].sort(), ['b.txt', 'folder/a.txt'], 'the "folder/" entry is skipped');
  for (const loc of locs.values()) {
    assert.equal(typeof loc.offset, 'number');
    assert.equal(typeof loc.csize, 'number');
    assert.ok(loc.method === 0 || loc.method === 8);
  }
});

test('readZipEntryAt seeks straight to a recorded location and inflates it', async () => {
  const p = makeZip({ 'a.txt': BODY_A, 'b.txt': BODY_B });
  const locs = await zipLocations(p);
  const a = await readZipEntryAt(p, locs.get('a.txt')!);
  assert.ok(a.equals(BODY_A));
  const b = await readZipEntryAt(p, locs.get('b.txt')!);
  assert.ok(b.equals(BODY_B));
});

test('readZipEntryAt reads a stored (method 0) entry verbatim', async () => {
  // Hand-build a minimal STORED zip (adm-zip always deflates).
  const name = Buffer.from('raw.bin');
  const data = Buffer.from('stored, not compressed, bytes');
  const crc = 0; // not validated by readZipEntryAt
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4); // version
  lfh.writeUInt16LE(0, 6); // flags
  lfh.writeUInt16LE(0, 8); // method 0 = stored
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(data.length, 18); // compressed size
  lfh.writeUInt32LE(data.length, 22); // uncompressed size
  lfh.writeUInt16LE(name.length, 26);
  lfh.writeUInt16LE(0, 28); // extra length
  const archive = Buffer.concat([lfh, name, data]); // no central directory needed for readZipEntryAt
  const p = path.join(tmp, 'stored.zip');
  fs.writeFileSync(p, archive);

  const bytes = await readZipEntryAt(p, { offset: 0, csize: data.length, method: 0 });
  assert.ok(bytes.equals(data), 'method 0 returns the raw bytes without inflating');
});

test('readZipEntryAt rejects a wrong offset and an unsupported method', async () => {
  const p = makeZip({ 'a.txt': BODY_A });
  const loc = (await zipLocations(p)).get('a.txt')!;
  await assert.rejects(() => readZipEntryAt(p, { ...loc, offset: loc.offset + 3 }), /local file header/);
  await assert.rejects(() => readZipEntryAt(p, { ...loc, method: 99 }), /unsupported zip compression method 99/);
  await assert.rejects(() => readZipEntryAt(p, { ...loc, csize: loc.csize + 5000 }), /truncated/);
  // Offset so close to EOF that the 30-byte header read comes up short.
  const size = fs.statSync(p).size;
  await assert.rejects(() => readZipEntryAt(p, { ...loc, offset: size - 5 }), /local file header/);
});

test('readZipEntryAt uses the local header name/extra lengths to find the data', async () => {
  // The data must decode to EXACTLY the original - a mis-computed start offset
  // would inflate garbage or throw.
  const p = makeZip({ 'some/nested/path.fb2': BODY_A });
  const loc = (await zipLocations(p)).get('some/nested/path.fb2')!;
  assert.ok((await readZipEntryAt(p, loc)).equals(BODY_A));
});

test('opening a file that is not a zip rejects', async () => {
  const p = path.join(tmp, 'not.zip');
  fs.writeFileSync(p, 'plain text, definitely not a zip');
  await assert.rejects(async () => {
    for await (const _e of zipEntries(p)) void _e;
  });
});

// The reader must release the archive's file descriptor after every call - a
// leak here exhausts the process fd table on a large collection scan.
const FD_DIR = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
const openFdCount = (): number => fs.readdirSync(FD_DIR).length;

test('every reader closes the archive file descriptor when it is done', async (t) => {
  if (!fs.existsSync(FD_DIR)) return t.skip(`no ${FD_DIR} on this platform`);
  const p = makeZip({ 'a.txt': BODY_A, 'b.txt': BODY_B });
  const loc = (await zipLocations(p)).get('a.txt')!;

  const runs: Array<() => Promise<unknown>> = [
    async () => {
      for await (const _e of zipEntries(p)) void _e;
    },
    () => readZipEntry(p, 'a.txt'),
    () => zipLocations(p),
    () => readZipEntryAt(p, loc),
  ];

  for (const run of runs) {
    await run(); // warm up (module-level caches, lazy requires)
    const before = openFdCount();
    for (let i = 0; i < 30; i++) await run();
    const after = openFdCount();
    assert.ok(after - before <= 4, `fd count grew by ${after - before} over 30 calls`);
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
