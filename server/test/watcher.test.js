import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-watch-'));
const books = path.join(tmp, 'books');
fs.mkdirSync(books, { recursive: true });
process.env.SOPDS_DB = path.join(tmp, 'test.db');
process.env.SOPDS_ROOT_LIB = books;

const settings = await import('../src/settings.js');
const db = (await import('../src/db.js')).default;
const { startWatcher, stopWatcher, watcherState } = await import('../src/watcher.js');
const { onScanDone } = await import('../src/scheduler.js');

const FB2 = (title) => `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>prose</genre>
<author><first-name>A</first-name><last-name>B</last-name></author>
<book-title>${title}</book-title><lang>en</lang></title-info></description>
<body><section><p>x</p></section></body></FictionBook>`;

const bookCount = () => db.prepare('SELECT COUNT(*) c FROM books').get().c;

before(() => {
  settings.setMany({ watchDebounce: 1, watchEnabled: true });
  startWatcher();
});
after(() => {
  stopWatcher();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('watcherState reflects the settings', () => {
  assert.equal(watcherState().enabled, true);
  assert.equal(watcherState().watching, true);
  assert.ok(watcherState().watchedDirs >= 1);
});

test('adding a file triggers an automatic scan', async () => {
  assert.equal(bookCount(), 0);

  const scanned = new Promise((resolve) => {
    const off = onScanDone((rec) => {
      off();
      resolve(rec);
    });
  });

  fs.writeFileSync(path.join(books, 'watched.fb2'), FB2('Watched Book'));

  const rec = await Promise.race([
    scanned,
    sleep(8000, { timeout: true }, { ref: false }),
  ]);
  assert.ok(!rec.timeout, 'a scan should have run within 8s of the file appearing');
  assert.equal(bookCount(), 1);
  assert.equal(
    db.prepare('SELECT title FROM books LIMIT 1').get().title,
    'Watched Book',
  );
});

test('disabling the watch stops watchers', () => {
  settings.setMany({ watchEnabled: false });
  assert.equal(watcherState().watching, false);
});
