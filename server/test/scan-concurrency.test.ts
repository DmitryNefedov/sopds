import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// `scanConcurrency` readers share one Writer, so anything the Writer accumulates
// across an `await` is exposed to a lost update. These run the walk against a
// database with realistic round-trip latency — without it a bulk INSERT
// completes before the next chunk is ready and the interleaving never happens.

process.env.SOPDS_TEST_DB ??= 'mem';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-conc-'));
const lib = path.join(tmp, 'books');
fs.mkdirSync(lib, { recursive: true });
process.env.SOPDS_ROOT_LIB = lib;

const { default: db } = await import('../src/db/index.js');
const { initSchema } = await import('../src/db/schema.js');
const settings = await import('../src/services/settings.js');
const { runOnce } = await import('../src/services/scanner/engine.js');

const ARCHIVES = 12;
const PER_ARCHIVE = 400;
const TOTAL = ARCHIVES * PER_ARCHIVE;

const FB2 = (title: string) => Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<FictionBook><description><title-info><genre>sf</genre>
<author><first-name>A</first-name><last-name>B</last-name></author>
<book-title>${title}</book-title><lang>en</lang></title-info></description>
<body><section><p>body</p></section></body></FictionBook>`);

const bookCount = async () =>
  (await db.get<{ c: number }>('SELECT COUNT(*)::int AS c FROM books'))!.c;

before(async () => {
  await initSchema();
  await settings.loadSettings();
  for (let a = 0; a < ARCHIVES; a++) {
    const zip = new AdmZip();
    for (let i = 0; i < PER_ARCHIVE; i++) zip.addFile(`b${a}_${i}.fb2`, FB2(`T${a}_${i}`));
    zip.writeZip(path.join(lib, `pack${a}.zip`));
  }

  // Stand in for a Postgres on the other side of a docker network: every
  // statement in the scan's transaction takes a round trip.
  const realBegin = db.begin.bind(db);
  db.begin = async () => {
    const tx = await realBegin();
    const delay = <F extends (...args: never[]) => Promise<unknown>>(f: F): F =>
      (async (...args: never[]) => {
        await new Promise((r) => setTimeout(r, 3));
        return f(...args);
      }) as F;
    return {
      ...tx,
      all: delay(tx.all),
      get: delay(tx.get),
      run: delay(tx.run),
      query: delay(tx.query),
    };
  };
});

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.end();
});

for (const concurrency of [1, 4, 8]) {
  test(`the reported added count is exact with ${concurrency} reader(s)`, async () => {
    await db.exec('TRUNCATE books, authors, series, catalogs, counters RESTART IDENTITY CASCADE');
    await settings.setMany({ scanBatchSize: 1000, scanConcurrency: concurrency });

    const stats = await runOnce({ log: () => {} });
    assert.equal(await bookCount(), TOTAL, 'every book is catalogued');
    // The counter is accumulated across awaits by readers running in parallel.
    assert.equal(stats.added, TOTAL, 'added matches what actually landed');
    assert.equal(stats.skipped, 0);
    assert.equal(stats.bad, 0);
    assert.equal(stats.archives, ARCHIVES);

    const counter = await db.get<{ value: number }>(
      "SELECT value FROM counters WHERE name = 'allbooks'",
    );
    assert.equal(counter!.value, TOTAL, 'the dashboard counter agrees');
  });
}

test('a second scan recognises everything and adds nothing', async () => {
  const stats = await runOnce({ log: () => {} });
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
  assert.equal(stats.archives, 0, 'unchanged archives are not reopened');
  assert.equal(stats.skipped, ARCHIVES);
  assert.equal(await bookCount(), TOTAL);
});
