import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Serving a cover used to walk the archive's central directory (O(entries)) and
// SAX-parse the whole book; now the scan records each entry's location and the
// cover is sliced out by byte offset. These check both shortcuts against the old
// path, and that each still works when its shortcut is unavailable.

process.env.SOPDS_TEST_DB ??= 'mem';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-cov-'));
const lib = path.join(tmp, 'books');
fs.mkdirSync(lib, { recursive: true });
process.env.SOPDS_ROOT_LIB = lib;

const { default: db } = await import('../src/db/index.js');
const { initSchema } = await import('../src/db/schema.js');
const settings = await import('../src/services/settings.js');
const { runOnce } = await import('../src/services/scanner/engine.js');
const { readBookBytes, readBookCover } = await import('../src/connectors/bookfiles.js');
const { parseFb2, fb2Cover } = await import('../src/formats/fb2.js');
const { zipLocations, readZipEntryAt } = await import('../src/connectors/zip.js');

const jpeg = (seed: number): Buffer => {
  const b = Buffer.alloc(600 + seed);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  for (let i = 4; i < b.length; i++) b[i] = (i * 31 + seed) & 0xff;
  b[b.length - 2] = 0xff; b[b.length - 1] = 0xd9;
  return b;
};
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(300, 0x5a),
]);

const FB2 = (title: string, cover: Buffer, mime = 'image/jpeg', id = 'cover.jpg'): Buffer =>
  Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>sf</genre>
<author><first-name>Иван</first-name><last-name>Петров</last-name></author>
<book-title>${title}</book-title><lang>ru</lang>
<coverpage><image l:href="#${id}"/></coverpage></title-info>
<document-info><date value="2011-05-03">2011</date></document-info></description>
<body>${'<p>тело книги</p>'.repeat(2000)}</body>
<binary id="${id}" content-type="${mime}">${cover.toString('base64')}</binary>
</FictionBook>`, 'utf8');

const COVERS: Record<string, Buffer> = {
  'Zipped One': jpeg(1),
  'Zipped Two': jpeg(2),
  'Zipped Png': png,
  'Loose One': jpeg(4),
};

const book = (title: string) =>
  db.get<{ id: number; path: string; filename: string; cat_type: number;
           zip_offset: number | null; zip_csize: number | null; zip_method: number | null }>(
    'SELECT * FROM books WHERE title = ?',
    [title],
  );

before(async () => {
  await initSchema();
  await db.exec(
    'TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE',
  );
  await settings.loadSettings();
  await settings.setMany({ scanBatchSize: 1000, zipScan: true, deleteMissing: true });

  fs.writeFileSync(path.join(lib, 'loose.fb2'), FB2('Loose One', COVERS['Loose One']));
  const zip = new AdmZip();
  zip.addFile('one.fb2', FB2('Zipped One', COVERS['Zipped One']));
  // Padding so the entries we care about sit at very different offsets.
  for (let i = 0; i < 40; i++) zip.addFile(`pad${i}.fb2`, FB2(`Pad ${i}`, jpeg(100 + i)));
  zip.addFile('two.fb2', FB2('Zipped Two', COVERS['Zipped Two']));
  zip.addFile('three.fb2', FB2('Zipped Png', COVERS['Zipped Png'], 'image/png', 'cover.png'));
  zip.writeZip(path.join(lib, 'pack.zip'));

  await runOnce({ log: () => {} });
});

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.end();
});

test('the scan records where each zip entry lives', async () => {
  const locs = await zipLocations(path.join(lib, 'pack.zip'));
  for (const title of ['Zipped One', 'Zipped Two', 'Zipped Png']) {
    const b = (await book(title))!;
    const want = locs.get(b.filename)!;
    assert.equal(Number(b.zip_offset), want.offset, `${title} offset`);
    assert.equal(Number(b.zip_csize), want.csize, `${title} compressed size`);
    assert.equal(Number(b.zip_method), want.method, `${title} method`);
  }
  // Loose files have no archive to point into.
  const loose = (await book('Loose One'))!;
  assert.equal(loose.zip_offset, null);
});

test('reading by recorded offset returns exactly the same bytes', async () => {
  const archive = path.join(lib, 'pack.zip');
  const b = (await book('Zipped Two'))!;
  const direct = await readZipEntryAt(archive, {
    offset: Number(b.zip_offset),
    csize: Number(b.zip_csize),
    method: Number(b.zip_method),
  });
  assert.deepEqual(direct, FB2('Zipped Two', COVERS['Zipped Two']));
  assert.deepEqual(await readBookBytes(b), direct);
});

test('covers come back correctly, from the archive and from disk', async () => {
  for (const [title, want] of Object.entries(COVERS)) {
    const img = await readBookCover((await book(title))!);
    assert.ok(img, `${title} has a cover`);
    assert.deepEqual(img!.data, want, `${title} cover bytes`);
  }
  const png = await readBookCover((await book('Zipped Png'))!);
  assert.equal(png!.mime, 'image/png');
});

test('the byte extractor agrees with the XML parser', async () => {
  for (const [title, want] of Object.entries(COVERS)) {
    const bytes = await readBookBytes((await book(title))!);
    const quick = fb2Cover(bytes);
    const viaSax = parseFb2(bytes);
    assert.ok(quick, `${title}: byte extractor found a cover`);
    assert.deepEqual(quick!.data, want);
    assert.deepEqual(quick!.data, viaSax.coverData, `${title}: same bytes as the parser`);
    assert.equal(quick!.mime, viaSax.coverMime, `${title}: same mime as the parser`);
  }
});

test('a book with no cover yields none rather than junk', async () => {
  const noCover = Buffer.from(
    '<?xml version="1.0"?><FictionBook><description><title-info>' +
      '<book-title>Bare</book-title></title-info></description><body><p>x</p></body></FictionBook>',
  );
  assert.equal(fb2Cover(noCover), null);
});

test('a stale recorded offset falls back to looking the entry up by name', async () => {
  const b = (await book('Zipped One'))!;
  const wrong = { ...b, zip_offset: 999_999_999, zip_csize: 10, zip_method: 8 };
  // Nothing is at that offset, so readBookBytes has to fall back.
  assert.deepEqual(await readBookBytes(wrong), FB2('Zipped One', COVERS['Zipped One']));
  const img = await readBookCover(wrong);
  assert.deepEqual(img!.data, COVERS['Zipped One']);
});

test('a row with no recorded location still works', async () => {
  const b = (await book('Zipped Two'))!;
  const bare = { path: b.path, filename: b.filename, cat_type: b.cat_type };
  assert.deepEqual(await readBookBytes(bare), FB2('Zipped Two', COVERS['Zipped Two']));
});

test('rescanning a rewritten archive refreshes the offsets it already knew', async () => {
  const archive = path.join(lib, 'pack.zip');
  const before = (await book('Zipped Two'))!;

  // Rebuild with an extra leading entry so everything after it shifts.
  const zip = new AdmZip();
  zip.addFile('aaa-new.fb2', FB2('Fresh One', jpeg(9)));
  zip.addFile('one.fb2', FB2('Zipped One', COVERS['Zipped One']));
  for (let i = 0; i < 40; i++) zip.addFile(`pad${i}.fb2`, FB2(`Pad ${i}`, jpeg(100 + i)));
  zip.addFile('two.fb2', FB2('Zipped Two', COVERS['Zipped Two']));
  zip.addFile('three.fb2', FB2('Zipped Png', COVERS['Zipped Png'], 'image/png', 'cover.png'));
  zip.writeZip(archive);

  const stats = await runOnce({ log: () => {} });
  assert.ok(stats.skipped > 0, 'the entries it already knew were not re-parsed');

  const locs = await zipLocations(archive);
  const after = (await book('Zipped Two'))!;
  assert.notEqual(Number(after.zip_offset), Number(before.zip_offset), 'the entry moved');
  assert.equal(Number(after.zip_offset), locs.get(after.filename)!.offset, 'and was updated');
  assert.deepEqual((await readBookCover(after))!.data, COVERS['Zipped Two']);
});
