import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Each supported format gets a different shortcut during a scan, and it is easy
// to widen one to a format it is wrong for. These pin down which is which, and
// prove that reading only the planned bytes yields the same catalogue row as
// reading the whole file — against the real sample books in test/fixtures.

process.env.SOPDS_TEST_DB ??= 'mem';

const FIX = path.join(import.meta.dirname, 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-fmt-'));
const lib = path.join(tmp, 'books');
fs.mkdirSync(lib, { recursive: true });
process.env.SOPDS_ROOT_LIB = lib;

const { default: db, initSchema } = await import('../src/db.js');
const settings = await import('../src/settings.js');
const { runOnce } = await import('../src/scan/engine.js');
const { parseBook, metaReadPlan, MOBI_HEAD_LIMIT } = await import('../src/books/index.js');
const { FB2_HEAD_LIMIT } = await import('../src/books/fb2.js');

const SAMPLES = {
  '262001.fb2': 'The Sanctuary Sparrow',
  'robin_cook.mobi': 'Vector',
  'mirer.epub': 'У меня девять жизней (шф (продолжатели))',
} as const;

// A PDF we never introspect: the scan must not read a byte of it.
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64 * 1024, 0x20)]);

before(async () => {
  await initSchema();
  await db.exec(
    'TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE',
  );
  await settings.loadSettings();
  await settings.setMany({ scanBatchSize: 100, zipScan: true, deleteMissing: true });

  const zip = new AdmZip();
  for (const name of Object.keys(SAMPLES)) {
    const bytes = fs.readFileSync(path.join(FIX, name));
    fs.writeFileSync(path.join(lib, name), bytes); // loose …
    zip.addFile(name, bytes); //                      … and archived
  }
  fs.writeFileSync(path.join(lib, 'paper.pdf'), PDF);
  zip.addFile('paper.pdf', PDF);
  zip.writeZip(path.join(lib, 'pack.zip'));
});

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.end();
});

test('each format is read only as far as its parser looks', () => {
  assert.deepEqual(metaReadPlan('a.fb2'), {
    need: 'head',
    limit: FB2_HEAD_LIMIT,
    stopAt: Buffer.from('</description>', 'latin1'),
  });
  assert.deepEqual(metaReadPlan('a.mobi'), { need: 'head', limit: MOBI_HEAD_LIMIT });
  // An epub is a zip: its central directory is at the end, so no shortcut.
  assert.deepEqual(metaReadPlan('a.epub'), { need: 'all' });
  // Nothing to introspect, so the bytes are never read.
  for (const f of ['a.pdf', 'a.djvu', 'a.txt']) {
    assert.deepEqual(metaReadPlan(f), { need: 'none' }, f);
  }
  assert.deepEqual(metaReadPlan('A.FB2'), metaReadPlan('a.fb2'), 'extension case is ignored');
});

test('a planned read gives the same metadata as reading the whole file', () => {
  for (const [name, title] of Object.entries(SAMPLES)) {
    const whole = fs.readFileSync(path.join(FIX, name));
    const plan = metaReadPlan(name);
    const partial =
      plan.need === 'all' ? whole : whole.subarray(0, plan.need === 'head' ? plan.limit : 0);

    const fromWhole = parseBook(whole, name, { metaOnly: true });
    const fromPlan = parseBook(partial, name, { metaOnly: true });
    assert.equal(fromWhole.title, title, `${name} baseline title`);
    assert.deepEqual(fromPlan, fromWhole, `${name}: planned read matches the full read`);
  }
});

test('the scan catalogues every format, loose and inside a zip', async () => {
  const stats = await runOnce({ log: () => {} });
  assert.equal(stats.bad, 0);
  assert.equal(stats.added, 8, '4 formats x (loose + archived)');

  for (const [name, title] of Object.entries(SAMPLES)) {
    const rows = await db.all<{ title: string; cat_type: number; filesize: number }>(
      'SELECT title, cat_type, filesize FROM books WHERE filename = ? ORDER BY cat_type',
      [name],
    );
    assert.equal(rows.length, 2, `${name}: found loose and archived`);
    for (const r of rows) {
      assert.equal(r.title, title, `${name} (cat_type ${r.cat_type}) parsed its real title`);
      assert.equal(
        Number(r.filesize),
        fs.statSync(path.join(FIX, name)).size,
        `${name} (cat_type ${r.cat_type}) filesize is the whole file`,
      );
    }
  }
});

test('a format with no parser is catalogued from its name, not its bytes', async () => {
  const rows = await db.all<{ title: string; format: string; filesize: number }>(
    "SELECT title, format, filesize FROM books WHERE filename = 'paper.pdf' ORDER BY cat_type",
  );
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.title, 'paper');
    assert.equal(r.format, 'pdf');
    // The size still comes from the filesystem / central directory, so a book
    // we never opened is still listed with its real size.
    assert.equal(Number(r.filesize), PDF.length);
  }
});
