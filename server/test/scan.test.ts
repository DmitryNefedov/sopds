import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// The Scanner (scan/index.ts): triggering, the concurrency mutex + queue-one,
// the run/last-run state, and starting/stopping the folder watch on a setting
// change. The collection walk itself is covered in engine.test.ts.

process.env.SOPDS_TEST_DB ??= 'mem';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-scanner-'));
const books = path.join(tmp, 'books');
fs.mkdirSync(books, { recursive: true });
process.env.SOPDS_ROOT_LIB = books;

const { default: db, initSchema } = await import('../src/db.js');
const settings = await import('../src/settings.js');
const { Scanner } = await import('../src/scan/index.js');

const FB2 = (title: string) => `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>prose</genre>
<author><first-name>A</first-name><last-name>B</last-name></author>
<book-title>${title}</book-title><lang>en</lang></title-info></description>
<body><section><p>x</p></section></body></FictionBook>`;

const bookCount = async () =>
  (await db.get<{ c: number }>('SELECT COUNT(*)::int AS c FROM books'))!.c;

const idle = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (!Scanner.status().running) return;
    await sleep(25);
  }
  throw new Error('scan never went idle');
};

before(async () => {
  await initSchema();
  await db.exec('TRUNCATE books, authors, series, catalogs, counters RESTART IDENTITY CASCADE');
  await settings.loadSettings();
  await settings.setMany({ watchDebounce: 1, watchEnabled: false, scanEnabled: false });
  fs.writeFileSync(path.join(books, 'one.fb2'), FB2('One'));
  fs.writeFileSync(path.join(books, 'two.fb2'), FB2('Two'));
});

after(async () => {
  Scanner.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.end();
});

test('trigger() runs the walk and records the result', async () => {
  const r = Scanner.trigger('manual');
  assert.deepEqual(r, { started: true, queued: false });
  assert.equal(Scanner.status().running, true);

  await idle();
  assert.equal(await bookCount(), 2);

  const { last } = Scanner.status();
  assert.equal(last?.reason, 'manual');
  assert.equal(last?.added, 2);
});

test('a trigger during a run queues exactly one follow-up', async () => {
  const a = Scanner.trigger('manual');
  const b = Scanner.trigger('watch'); // arrives while `a` is still running
  const c = Scanner.trigger('schedule'); // overwrites the pending reason

  assert.deepEqual(a, { started: true, queued: false });
  assert.deepEqual(b, { started: false, queued: true });
  assert.deepEqual(c, { started: false, queued: true });

  await idle(); // first run finishes …
  await sleep(50);
  await idle(); // … then the single queued run
  assert.equal(Scanner.status().last?.reason, 'schedule'); // last reason wins
});

test('status() reflects the schedule + watch settings', async () => {
  assert.equal(Scanner.status().enabled, false);
  assert.equal(Scanner.status().watch.watching, false);

  Scanner.start();
  await settings.setMany({ watchEnabled: true });
  assert.equal(Scanner.status().watch.watching, true);

  await settings.setMany({ watchEnabled: false });
  assert.equal(Scanner.status().watch.watching, false);
});
