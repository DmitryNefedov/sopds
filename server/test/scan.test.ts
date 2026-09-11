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

const { default: db } = await import('../src/db/index.js');
const { initSchema } = await import('../src/db/schema.js');
const settings = await import('../src/services/settings.js');
const { Scanner } = await import('../src/services/scanner/index.js');

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
  assert.deepEqual(Scanner.status().progress, { added: 0, skipped: 0 }, 'progress starts at zero');

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
  assert.equal(Scanner.status().watch.watching, false, 'start() with watchEnabled off leaves the watch down');
  await settings.setMany({ watchEnabled: true });
  assert.equal(Scanner.status().watch.watching, true);
  assert.equal(Scanner.status().watch.watchedDirs, 1, 'just the (empty-of-subdirs) books root');

  // Re-point the collection while the watch is live.
  const books2 = path.join(tmp, 'books2');
  fs.mkdirSync(path.join(books2, 'sub'), { recursive: true });
  await settings.setMany({ rootLib: books2 });
  assert.equal(Scanner.status().watch.watching, true, 'still watching after the rootLib change');
  assert.equal(Scanner.status().watch.watchedDirs, 2, 'now books2 + books2/sub');
  await settings.setMany({ rootLib: books });

  await settings.setMany({ watchEnabled: false });
  assert.equal(Scanner.status().watch.watching, false);
});

test('status() cron / enabled follow the settings, and changing them resets the tick', async () => {
  Scanner.start();
  await settings.setMany({ scanEnabled: true, scanCron: '0 3 * * *' });
  assert.equal(Scanner.status().enabled, true);
  assert.equal(Scanner.status().cron, '0 3 * * *');
  await settings.setMany({ scanEnabled: false });
  assert.equal(Scanner.status().enabled, false);
});

test('start() reacts to live setting changes: watch on/off, rootLib re-point, schedule reset', async () => {
  Scanner.start();

  // 1. watchEnabled true -> the watch comes up (via the onChange listener).
  await settings.setMany({ watchEnabled: true });
  assert.equal(Scanner.status().watch.watching, true);

  // 1b. a fresh start() with watchEnabled already on brings the watch up too.
  Scanner.stop();
  assert.equal(Scanner.status().watch.watching, false);
  Scanner.start();
  assert.equal(Scanner.status().watch.watching, true, 'start() honours a pre-set watchEnabled');

  // 2. rootLib change while watching -> the watch is re-pointed, not left stale.
  const b3 = path.join(tmp, 'books3');
  fs.mkdirSync(path.join(b3, 'x', 'y'), { recursive: true });
  await settings.setMany({ rootLib: b3 });
  assert.equal(Scanner.status().watch.watching, true);
  assert.equal(Scanner.status().watch.watchedDirs, 3, 'books3 + x + x/y');
  await settings.setMany({ rootLib: books });

  // 3. an enabled schedule whose cron matches now -> start() ticks and triggers.
  Scanner.trigger('manual');
  await idle();
  assert.equal(Scanner.status().last?.reason, 'manual', 'baseline');

  await settings.setMany({ scanEnabled: true, scanCron: '* * * * *' });
  Scanner.stop();
  Scanner.start(); // start() ticks immediately; the cron matches every minute
  await idle();
  assert.equal(Scanner.status().last?.reason, 'schedule', 'the scheduled tick triggered a run');

  await settings.setMany({ scanEnabled: false, watchEnabled: false });
  Scanner.stop();
});

test('a walk that returns an error result records the error, not a crash', async () => {
  // A collection directory that does not exist: runOnce returns an error result.
  await settings.setMany({ rootLib: path.join(tmp, 'nowhere-at-all') });

  Scanner.trigger('manual');
  await idle();
  const { last } = Scanner.status();
  assert.equal(last?.reason, 'manual');
  assert.ok(last && typeof last.startedAt === 'string' && typeof last.finishedAt === 'string');
  assert.ok(last && 'error' in last && typeof last.error === 'string' && last.error.length > 0);
  assert.equal(Scanner.status().running, false, 'the run still settled');

  await settings.setMany({ rootLib: books });
});

test('a walk that throws mid-run is caught and recorded as an error', async () => {
  // Break the schema so runOnce()'s very first UPDATE throws (and rethrows).
  await db.exec('DROP TABLE IF EXISTS books CASCADE');
  try {
    Scanner.trigger('manual');
    await idle();
    const { last } = Scanner.status();
    assert.equal(last?.reason, 'manual');
    assert.ok(last && 'error' in last && typeof last.error === 'string' && last.error.length > 0);
    assert.match((last as { error: string }).error, /books/i, 'the pg error mentions the missing table');
    assert.equal(Scanner.status().running, false);
  } finally {
    await initSchema(); // recreate `books` (all statements are IF NOT EXISTS)
    Scanner.stop();
  }
});
