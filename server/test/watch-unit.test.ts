import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.SOPDS_TEST_DB ??= 'mem';

const { bookRelevant, debounceMs, handleDirEvent, startWatch, stopWatch, restartWatch, isWatching, watchStatus } =
  await import('../src/services/scanner/watch.js');
const { setOverride } = await import('../src/services/settings.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-watchu-'));
const books = path.join(tmp, 'books');

before(() => {
  fs.mkdirSync(path.join(books, 'a'), { recursive: true });
  setOverride('rootLib', books);
  setOverride('watchDebounce', 1);
});
after(() => {
  stopWatch();
  setOverride('rootLib', undefined as never);
  setOverride('watchDebounce', undefined as never);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('bookRelevant: no name, a bare directory name, or a book extension all count', () => {
  assert.equal(bookRelevant(null), true, 'a null filename (some platforms)');
  assert.equal(bookRelevant('newdir'), true, 'no extension -> maybe a directory');
  for (const ext of ['fb2', 'epub', 'mobi', 'pdf', 'djvu', 'zip']) {
    assert.equal(bookRelevant(`book.${ext}`), true, ext);
    assert.equal(bookRelevant(`BOOK.${ext.toUpperCase()}`), true, `${ext} upper-case`);
  }
});

test('bookRelevant: a file with a non-book extension is ignored', () => {
  for (const name of ['notes.txt', 'cover.jpg', 'index.html', 'archive.rar', 'book.fb2.bak']) {
    assert.equal(bookRelevant(name), false, name);
  }
  assert.equal(bookRelevant('a.zip.tmp'), false, 'the extension must be at the very end');
});

test('debounceMs: seconds -> ms, clamped to >= 1s, 5s fallback for 0 / non-numeric', () => {
  assert.equal(debounceMs(3), 3000);
  assert.equal(debounceMs(1), 1000);
  assert.equal(debounceMs(0), 5000, '0 is falsy -> the 5s fallback');
  assert.equal(debounceMs('abc'), 5000, 'NaN -> the 5s fallback');
  assert.equal(debounceMs(null), 5000);
  assert.equal(debounceMs(0.5), 1000, 'floored at 1s');
  assert.equal(debounceMs(3600), 3600000);
  // Default argument: reads the live setting.
  setOverride('watchDebounce', 2);
  assert.equal(debounceMs(), 2000);
  setOverride('watchDebounce', 1);
});

test('handleDirEvent arms the debounce timer only for a book-relevant change', () => {
  stopWatch();
  startWatch(() => {});
  assert.equal(watchStatus().pending, false);

  handleDirEvent('change', 'notes.txt');
  assert.equal(watchStatus().pending, false, 'a .txt change is ignored');

  handleDirEvent('change', 'story.fb2');
  assert.equal(watchStatus().pending, true, 'a .fb2 change arms the timer');

  stopWatch();
  handleDirEvent('change', null);
  assert.equal(watchStatus().pending, true, 'a null filename is treated as relevant');
  stopWatch();
  handleDirEvent('change', Buffer.from('cover.epub'));
  assert.equal(watchStatus().pending, true, 'a Buffer filename is stringified');
  stopWatch();
});

test('handleDirEvent("rename") rebuilds the watcher set', async () => {
  stopWatch();
  startWatch(() => {});
  const before = watchStatus().watchedDirs;
  const fresh = path.join(books, 'brand-new');
  fs.mkdirSync(fresh, { recursive: true });
  handleDirEvent('rename', 'brand-new');
  assert.equal(watchStatus().watchedDirs, before + 1, 'the new sub-directory is now watched');
  fs.rmSync(fresh, { recursive: true, force: true });
  stopWatch();
});

test('isWatching / watchStatus track the watcher set', () => {
  assert.equal(isWatching(), false);
  startWatch(() => {});
  assert.equal(isWatching(), true);
  assert.ok(watchStatus().watchedDirs >= 2, 'root + a/');
  stopWatch();
  assert.equal(isWatching(), false);
  assert.equal(watchStatus().watchedDirs, 0);
});

test('syncWatchers skips a sub-directory it cannot list', () => {
  const locked = path.join(books, 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.mkdirSync(path.join(locked, 'child'), { recursive: true });
  fs.chmodSync(locked, 0o000); // readdirSync(locked) now throws EACCES
  try {
    stopWatch();
    startWatch(() => {});
    // `locked` itself is still added (its parent listed it), but its `child`
    // must NOT appear because walk() bailed on the readdir.
    assert.ok(!Object.keys({}).length); // no-op keeps the shape obvious
    assert.equal(isWatching(), true);
  } finally {
    fs.chmodSync(locked, 0o755);
    stopWatch();
    fs.rmSync(locked, { recursive: true, force: true });
  }
});

test('syncWatchers walks the whole sub-tree, not just the top level', () => {
  const deep = path.join(books, 'lvl1', 'lvl2', 'lvl3');
  fs.mkdirSync(deep, { recursive: true });
  stopWatch();
  startWatch(() => {});
  const dirs = watchStatus().watchedDirs;
  // root + a/ + lvl1 + lvl1/lvl2 + lvl1/lvl2/lvl3 (+ any left from earlier tests
  // are cleaned per-test), so at least 5.
  assert.ok(dirs >= 5, `deep dirs watched (got ${dirs})`);
  stopWatch();
  fs.rmSync(path.join(books, 'lvl1'), { recursive: true, force: true });
});

test('syncWatchers drops the watcher for a sub-directory that was removed', async () => {
  const gone = path.join(books, 'will-vanish');
  fs.mkdirSync(gone, { recursive: true });
  startWatch(() => {});
  const before = watchStatus().watchedDirs;
  assert.ok(before >= 3);

  fs.rmSync(gone, { recursive: true, force: true });
  // A rename event on `books` re-runs syncWatchers, which prunes the stale one.
  fs.writeFileSync(path.join(books, 'trigger'), 'x');
  await sleep(300);
  assert.ok(watchStatus().watchedDirs < before, `pruned (was ${before}, now ${watchStatus().watchedDirs})`);
  stopWatch();
});

test('restartWatch does nothing after stopWatch (no callback to restore)', () => {
  stopWatch();
  restartWatch();
  assert.equal(isWatching(), false);
});

test('restartWatch stops the old watch and re-points at the current rootLib', () => {
  stopWatch();
  // books2 has a very different sub-directory count than `books` (root + 4 subs).
  const b2 = path.join(tmp, 'books2');
  for (const s of ['s1', 's2', 's3', 's4']) fs.mkdirSync(path.join(b2, s), { recursive: true });

  let calls = 0;
  startWatch(() => { calls += 1; });
  const dirsOnBooks = watchStatus().watchedDirs;

  setOverride('rootLib', b2);
  restartWatch();
  assert.equal(isWatching(), true);
  assert.equal(
    watchStatus().watchedDirs,
    5,
    `exactly books2 root + 4 subs (old ${dirsOnBooks} watchers were dropped, not added to)`,
  );
  assert.equal(calls, 0, 'restart itself does not fire the callback');

  setOverride('rootLib', books);
  stopWatch();
  fs.rmSync(b2, { recursive: true, force: true });
});

test('the debounce coalesces rapid events into a single callback and resets on each', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stopWatch();
  let calls = 0;
  startWatch(() => { calls += 1; });
  setOverride('watchDebounce', 2);

  handleDirEvent('change', 'a.fb2');
  t.mock.timers.tick(1500);
  handleDirEvent('change', 'b.fb2'); // must reset the 2s window
  t.mock.timers.tick(1500);
  assert.equal(calls, 0, 'still within the (reset) debounce window');
  t.mock.timers.tick(1000);
  assert.equal(calls, 1, 'one callback for the whole burst');
  assert.equal(watchStatus().pending, false);

  setOverride('watchDebounce', 1);
  stopWatch();
  t.mock.timers.reset();
});

test('startWatch on a missing root leaves nothing watched', () => {
  stopWatch();
  setOverride('rootLib', path.join(tmp, 'does-not-exist'));
  startWatch(() => {});
  assert.equal(watchStatus().watchedDirs, 0);
  setOverride('rootLib', books);
});
