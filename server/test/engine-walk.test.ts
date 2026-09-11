import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// End-to-end walk scenarios that only surface through runOnce(): the
// seen/fresh split, the missing-book sweep (with deleteMissing on and off),
// bad files and archives, the progress callback, and re-reading a changed
// archive. The pure seams are in engine-unit.test.ts.

process.env.SOPDS_TEST_DB ??= 'mem';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-walk-'));
const lib = path.join(tmp, 'books');
fs.mkdirSync(lib, { recursive: true });
process.env.SOPDS_ROOT_LIB = lib;

const { default: db } = await import('../src/db/index.js');
const { initSchema } = await import('../src/db/schema.js');
const settings = await import('../src/services/settings.js');
const { runOnce } = await import('../src/services/scanner/engine.js');

const FB2 = (title: string, authors: string[] = ['Doe John'], extra = '') => {
  const authorTags = authors
    .map((a) => {
      const [last, first] = a.split(' ');
      return `<author><first-name>${first ?? ''}</first-name><last-name>${last}</last-name></author>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>sf</genre>${authorTags}
<book-title>${title}</book-title><lang>en</lang>${extra}</title-info></description>
<body><section><p>body</p></section></body></FictionBook>`;
};

const bookCount = async () =>
  (await db.get<{ c: number }>('SELECT COUNT(*)::int AS c FROM books'))!.c;
const titles = async () =>
  (await db.all<{ title: string }>('SELECT title FROM books ORDER BY title')).map((r) => r.title);

before(async () => {
  await initSchema();
  await settings.loadSettings();
});

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.end();
});

beforeEach(async () => {
  await db.exec(
    'TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE',
  );
  for (const e of fs.readdirSync(lib)) fs.rmSync(path.join(lib, e), { recursive: true, force: true });
  await settings.setMany({
    rootLib: lib,
    scanBatchSize: 100,
    zipScan: true,
    deleteMissing: true,
    scanConcurrency: 1,
  });
});

test('a second scan re-marks the unchanged files as seen and adds nothing', async () => {
  fs.writeFileSync(path.join(lib, 'one.fb2'), FB2('One'));
  fs.writeFileSync(path.join(lib, 'two.fb2'), FB2('Two'));
  const first = await runOnce({ log: () => {} });
  assert.equal(first.added, 2);
  assert.equal(first.skipped, 0, 'nothing was already known on the first pass');
  assert.equal(
    (await db.get<{ path: string }>("SELECT path FROM books WHERE title = 'One'"))!.path,
    '.',
    'a book at the collection root is filed under the synthetic "." path',
  );

  const second = await runOnce({ log: () => {} });
  assert.equal(second.added, 0, 'both recognised');
  assert.equal(second.skipped, 2, 'both counted as skipped');
  assert.equal(second.removed, 0);
  assert.equal(await bookCount(), 2);
  const avail = await db.all<{ avail: number }>('SELECT DISTINCT avail FROM books');
  assert.deepEqual(avail.map((a) => a.avail), [2], 'left available, not stuck at the pending mark');
});

test('runOnce logs the start-of-scan miss and the end-of-scan summary', async () => {
  await settings.setMany({ rootLib: path.join(tmp, 'not-a-real-dir') });
  const missLogs: string[] = [];
  const missing = await runOnce({ log: (m) => missLogs.push(m) });
  assert.ok('error' in missing);
  assert.ok(missLogs.some((l) => /not found/i.test(l) && l.includes('not-a-real-dir')));

  await settings.setMany({ rootLib: lib });
  fs.writeFileSync(path.join(lib, 'x.fb2'), FB2('X'));
  const doneLogs: string[] = [];
  await runOnce({ log: (m) => doneLogs.push(m) });
  assert.ok(
    doneLogs.some((l) => /Scan done\. added=1 skipped=0 removed=0 bad=0 archives=0/.test(l)),
    'the summary line carries every counter',
  );
});

test('a non-book entry inside an archive is ignored, not catalogued', async () => {
  const zip = new AdmZip();
  zip.addFile('real.fb2', Buffer.from(FB2('Real')));
  zip.addFile('readme.txt', Buffer.from('just notes'));
  zip.writeZip(path.join(lib, 'mixed.zip'));
  const stats = await runOnce({ log: () => {} });
  assert.equal(stats.added, 1, 'only the .fb2 entry');
  assert.deepEqual(await titles(), ['Real']);
  const loc = await db.get<{ zip_offset: number | null; zip_csize: number | null; zip_method: number | null }>(
    "SELECT zip_offset, zip_csize, zip_method FROM books WHERE title = 'Real'",
  );
  assert.ok(loc!.zip_offset != null && Number(loc!.zip_offset) >= 0, 'a real byte offset');
  assert.ok(loc!.zip_csize != null && Number(loc!.zip_csize) > 0, 'a real compressed size');
  assert.ok(loc!.zip_method != null, 'a real compression method');
});

test('deleteMissing on: a file gone from disk is swept at the end of the scan', async () => {
  fs.writeFileSync(path.join(lib, 'keep.fb2'), FB2('Keep'));
  fs.writeFileSync(path.join(lib, 'drop.fb2'), FB2('Drop'));
  await runOnce({ log: () => {} });
  assert.equal(await bookCount(), 2);

  fs.rmSync(path.join(lib, 'drop.fb2'));
  const stats = await runOnce({ log: () => {} });
  assert.equal(stats.removed, 1, 'the vanished book is reported removed');
  assert.deepEqual(await titles(), ['Keep']);
});

test('deleteMissing off: a vanished file is left in place, not removed', async () => {
  await settings.setMany({ deleteMissing: false });
  fs.writeFileSync(path.join(lib, 'keep.fb2'), FB2('Keep'));
  fs.writeFileSync(path.join(lib, 'drop.fb2'), FB2('Drop'));
  await runOnce({ log: () => {} });

  fs.rmSync(path.join(lib, 'drop.fb2'));
  const stats = await runOnce({ log: () => {} });
  assert.equal(stats.removed, 0, 'nothing is swept');
  assert.equal(await bookCount(), 2, 'the row survives');
});

test('a book file that cannot be read is counted as bad and logged, not fatal', async () => {
  fs.writeFileSync(path.join(lib, 'good.fb2'), FB2('Good'));
  // A dangling symlink: stat() follows it and throws ENOENT.
  fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(lib, 'broken.fb2'));
  const logs: string[] = [];
  const stats = await runOnce({ log: (m) => logs.push(m) });
  assert.equal(stats.bad, 1);
  assert.equal(stats.added, 1, 'the good book still lands');
  assert.ok(logs.some((l) => /bad book .*broken\.fb2/.test(l)), 'the bad file is named in the log');
});

test('an archive that is not a valid zip is counted as bad, and the scan carries on', async () => {
  fs.writeFileSync(path.join(lib, 'loose.fb2'), FB2('Loose'));
  fs.writeFileSync(path.join(lib, 'junk.zip'), Buffer.from('this is not a zip at all'));
  const logs: string[] = [];
  const stats = await runOnce({ log: (m) => logs.push(m) });
  assert.equal(stats.bad, 1);
  assert.equal(stats.added, 1);
  assert.ok(logs.some((l) => /bad archive .*junk\.zip/.test(l)));
});

test('onProgress fires after each committed batch with the running totals', async () => {
  await settings.setMany({ scanBatchSize: 2 });
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(lib, `b${i}.fb2`), FB2(`B${i}`));
  const seen: { added: number; skipped: number }[] = [];
  const stats = await runOnce({ log: () => {}, onProgress: (p) => seen.push({ ...p }) });
  assert.equal(stats.added, 6);
  assert.ok(seen.length >= 2, `progress reported several times, got ${seen.length}`);
  assert.equal(seen.at(-1)!.added, 6, 'the last callback carries the final count');
  assert.ok(
    seen.every((p) => typeof p.added === 'number' && typeof p.skipped === 'number'),
    'each callback gets a real {added, skipped}',
  );
});

test('books keep every one of their authors', async () => {
  fs.writeFileSync(path.join(lib, 'co.fb2'), FB2('Collaboration', ['Smith Ann', 'Jones Bob']));
  await runOnce({ log: () => {} });
  const rows = await db.all<{ full_name: string }>(
    `SELECT a.full_name FROM authors a
       JOIN book_authors ba ON ba.author_id = a.id
       JOIN books b ON b.id = ba.book_id
      WHERE b.title = 'Collaboration' ORDER BY a.full_name`,
  );
  assert.deepEqual(rows.map((r) => r.full_name), ['Jones Bob', 'Smith Ann']);
});

test('a changed archive is re-read; an untouched one on the next pass is skipped whole', async () => {
  const mk = (names: string[]) => {
    const zip = new AdmZip();
    for (const n of names) zip.addFile(n, Buffer.from(FB2(n.replace('.fb2', ''))));
    zip.writeZip(path.join(lib, 'pack.zip'));
  };
  mk(['a.fb2', 'b.fb2']);
  const first = await runOnce({ log: () => {} });
  assert.equal(first.added, 2);
  assert.equal(first.archives, 1);

  // Grow the archive: same two entries plus a new one.
  mk(['a.fb2', 'b.fb2', 'c.fb2']);
  const second = await runOnce({ log: () => {} });
  assert.equal(second.archives, 1, 'the size changed, so it is opened again');
  assert.equal(second.added, 1, 'only the new entry is parsed');
  assert.equal(second.skipped, 2, 'the two known entries are re-marked, not re-parsed');
  assert.equal(await bookCount(), 3);

  const third = await runOnce({ log: () => {} });
  assert.equal(third.archives, 0, 'unchanged now: not reopened');
  assert.equal(third.skipped, 1, 'the whole archive counts as one skip');
});

test('a corrupt entry inside an otherwise-readable archive is counted bad, not fatal', async () => {
  const zip = new AdmZip();
  zip.addFile('ok.fb2', Buffer.from(FB2('Okay')));
  zip.addFile('rotten.fb2', Buffer.from(FB2('Rotten').repeat(20)));
  const file = path.join(lib, 'part.zip');
  zip.writeZip(file);
  // Corrupt the deflate stream of the second entry: zero a run of bytes well
  // past both local file headers so yauzl's inflate throws when it is read.
  const bytes = fs.readFileSync(file);
  bytes.fill(0, 120, 180);
  fs.writeFileSync(file, bytes);

  const logs: string[] = [];
  const stats = await runOnce({ log: (m) => logs.push(m) });
  assert.equal(stats.bad, 1, 'the rotten entry is bad');
  assert.equal(stats.added, 1, 'the good entry still lands');
  assert.ok(
    logs.some((l) => /bad book .*part\.zip!.*\.fb2/.test(l)),
    `expected a "bad book" log for an entry in part.zip, got ${JSON.stringify(logs)}`,
  );
});

test('an error raised during the walk aborts the batch and propagates out of runOnce', async () => {
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(lib, `b${i}.fb2`), FB2(`B${i}`));
  const realBegin = db.begin.bind(db);
  let calls = 0;
  db.begin = async () => {
    if (++calls >= 1) throw new Error('db gone mid-scan');
    return realBegin();
  };
  try {
    await assert.rejects(runOnce({ log: () => {} }), /db gone mid-scan/);
  } finally {
    db.begin = realBegin;
  }
});

test('the batch-size setting is floored at 1', async () => {
  await settings.setMany({ scanBatchSize: 0 });
  fs.writeFileSync(path.join(lib, 'x.fb2'), FB2('X'));
  const stats = await runOnce({ log: () => {} });
  assert.equal(stats.added, 1, 'a zero batch size does not wedge the writer');
});
