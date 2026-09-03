import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Run against the in-process PostgreSQL (PGlite) unless told otherwise.
process.env.SOPDS_TEST_DB ??= 'mem';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-watch-'));
const books = path.join(tmp, 'books');
fs.mkdirSync(books, { recursive: true });
process.env.SOPDS_ROOT_LIB = books;

const settings = await import('../src/settings.js');
const { default: db, initSchema } = await import('../src/db.js');
const { startWatcher, stopWatcher, watcherState } = await import('../src/watcher.js');
const { onScanDone } = await import('../src/scheduler.js');

const FB2 = (title: string) => `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>prose</genre>
<author><first-name>A</first-name><last-name>B</last-name></author>
<book-title>${title}</book-title><lang>en</lang></title-info></description>
<body><section><p>x</p></section></body></FictionBook>`;

const bookCount = async () =>
  (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM books'))!.c;

before(async () => {
  await initSchema();
  await db.exec('TRUNCATE books, authors, series, catalogs RESTART IDENTITY CASCADE');
  await settings.loadSettings();
  await settings.setMany({ watchDebounce: 1, watchEnabled: true });
  startWatcher();
});
after(async () => {
  stopWatcher();
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.end();
});

test('watcherState reflects the settings', () => {
  assert.equal(watcherState().enabled, true);
  assert.equal(watcherState().watching, true);
  assert.ok(watcherState().watchedDirs >= 1);
});

test('adding a file triggers an automatic scan', async () => {
  assert.equal(await bookCount(), 0);

  const scanned = new Promise<{ timeout?: boolean }>((resolve) => {
    const off = onScanDone((rec) => {
      off();
      resolve(rec as { timeout?: boolean });
    });
  });

  fs.writeFileSync(path.join(books, 'watched.fb2'), FB2('Watched Book'));

  const rec = await Promise.race([
    scanned,
    sleep(8000, { timeout: true } as { timeout?: boolean }),
  ]);
  assert.ok(!rec.timeout, 'a scan should have run within 8s of the file appearing');
  assert.equal(await bookCount(), 1);
  assert.equal(
    (await db.get<{ title: string }>('SELECT title FROM books LIMIT 1'))!.title,
    'Watched Book',
  );
});

test('disabling the watch stops watchers', async () => {
  await settings.setMany({ watchEnabled: false });
  assert.equal(watcherState().watching, false);
});
