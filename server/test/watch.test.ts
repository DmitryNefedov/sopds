import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Unit test of the folder-watch seam (scan/watch.ts): a filesystem change under
// the collection root produces one debounced "settled" callback. No database,
// no scan — the Scanner wires the callback to a trigger, and that wiring is
// covered in scan.test.ts.

process.env.SOPDS_TEST_DB ??= 'mem';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-watch-'));
const books = path.join(tmp, 'books');
fs.mkdirSync(path.join(books, 'sub'), { recursive: true });

const { setOverride } = await import('../src/settings.js');
setOverride('rootLib', books);
setOverride('watchDebounce', 1);

const { startWatch, stopWatch, watchStatus } = await import('../src/scan/watch.js');

after(() => {
  stopWatch();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('startWatch watches the root and every sub-directory', () => {
  startWatch(() => {});
  const s = watchStatus();
  assert.equal(s.watching, true);
  assert.ok(s.watchedDirs >= 2, `root + sub expected, got ${s.watchedDirs}`);
});

test('a new book file produces one debounced callback', async () => {
  let calls = 0;
  stopWatch();
  startWatch(() => {
    calls++;
  });

  fs.writeFileSync(path.join(books, 'a.fb2'), 'x');
  fs.writeFileSync(path.join(books, 'sub', 'b.fb2'), 'y');

  await sleep(200);
  assert.equal(watchStatus().pending, true, 'a debounce timer is armed after the writes');

  await sleep(1500);
  assert.equal(calls, 1, 'two quick writes coalesce into one settled callback');
  assert.equal(watchStatus().pending, false);
});

test('stopWatch tears the watchers down', () => {
  startWatch(() => {});
  assert.equal(watchStatus().watching, true);
  stopWatch();
  assert.equal(watchStatus().watching, false);
  assert.equal(watchStatus().watchedDirs, 0);
});
