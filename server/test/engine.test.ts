import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Run against the in-process PostgreSQL (PGlite) unless told otherwise.
process.env.SOPDS_TEST_DB ??= 'mem';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-scan-'));
const lib = path.join(tmp, 'books');
fs.mkdirSync(lib, { recursive: true });
process.env.SOPDS_ROOT_LIB = lib;

const { default: db, initSchema } = await import('../src/db.js');
const settings = await import('../src/settings.js');
const { runOnce } = await import('../src/scan/engine.js');
const { readBookBytes } = await import('../src/files.js');

const FB2 = (title: string, author = 'Doe John') => {
  const [last, first] = author.split(' ');
  return `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>sf</genre>
<author><first-name>${first}</first-name><last-name>${last}</last-name></author>
<book-title>${title}</book-title><lang>en</lang></title-info></description>
<body><section><p>body</p></section></body></FictionBook>`;
};

const count = async (t: string) =>
  (await db.get<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${t}`))!.c;

before(async () => {
  await initSchema();
  await db.exec(
    'TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE',
  );
  await settings.loadSettings();
  await settings.setMany({ scanBatchSize: 3, zipScan: true, deleteMissing: true });

  // A loose book on disk …
  fs.writeFileSync(path.join(lib, 'loose.fb2'), FB2('Loose One', 'Loose Larry'));
  // … and a zip archive holding several, in a sub-directory.
  fs.mkdirSync(path.join(lib, 'packs'));
  const zip = new AdmZip();
  for (let i = 1; i <= 7; i++) zip.addFile(`book${i}.fb2`, Buffer.from(FB2(`Zipped ${i}`)));
  zip.writeZip(path.join(lib, 'packs', 'pack.zip'));
});

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.end();
});

test('scans loose files and zip entries, batching commits', async () => {
  const logs: string[] = [];
  const stats = await runOnce({ log: (m: string) => logs.push(m) });
  assert.equal(stats.added, 8); // 1 loose + 7 zipped
  assert.equal(stats.archives, 1);
  assert.equal(await count('books'), 8);

  // batchSize is 3, so the 8 books are committed/published in several batches
  // (not one final commit) — each flush logs a progress line.
  const flushes = logs.filter((m) => /books added so far/.test(m));
  assert.ok(flushes.length >= 2, `expected multiple batch flushes, got ${flushes.length}`);

  // The zip was read, not expanded: only the archive exists on disk.
  assert.deepEqual(fs.readdirSync(path.join(lib, 'packs')), ['pack.zip']);

  // Zip books point at the archive as their catalog (cat_type = 1).
  const zc = await db.get<{ cat_type: number }>(
    "SELECT cat_type FROM catalogs WHERE path = 'packs/pack.zip'",
  );
  assert.equal(zc!.cat_type, 1);
});

test('a book inside the zip can be read back without extraction', async () => {
  const book = await db.get<{ path: string; filename: string; cat_type: number }>(
    "SELECT path, filename, cat_type FROM books WHERE title = 'Zipped 3'",
  );
  const buf = await readBookBytes(book!);
  assert.match(buf.toString('utf8'), /<book-title>Zipped 3<\/book-title>/);
});

test('re-scanning an unchanged archive skips it', async () => {
  const stats = await runOnce({ log: () => {} });
  assert.equal(stats.added, 0);
  assert.equal(stats.archives, 0); // archive unchanged: not re-read
  assert.equal(await count('books'), 8);
});

test('counters reflect the added books', async () => {
  const c = await db.get<{ value: number }>("SELECT value FROM counters WHERE name = 'allbooks'");
  assert.equal(c!.value, 8);
});
