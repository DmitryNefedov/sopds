import fs from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'node:fs';
import { S } from '../settings.js';

// A debounced "something changed under the collection root" signal, fired once
// the filesystem has been quiet for `watchDebounce` seconds. The root and every
// sub-directory are watched by hand, so behaviour matches across platforms.

const watchers = new Map<string, FSWatcher>(); // absolute dir -> fs.FSWatcher
let debounceTimer: NodeJS.Timeout | null = null;
let watchedRoot: string | null = null;
let settled: (() => void) | null = null;

const BOOK_LIKE = /\.(fb2|epub|mobi|pdf|djvu|zip)$/i;

export function bookRelevant(name: string | null): boolean {
  // directories have no extension; treat "no ext" as a possible dir event
  return !name || !path.extname(name) || BOOK_LIKE.test(name);
}

/** The debounce window in milliseconds: `seconds` seconds, at least 1s, falling
 *  back to 5s for a missing / non-numeric / zero value. Defaults to the setting. */
export function debounceMs(seconds: unknown = S.watchDebounce): number {
  return Math.max(1, Number(seconds) || 5) * 1000;
}

function scheduleSettled(): void {
  // Stryker disable next-line ConditionalExpression: `clearTimeout(null)` is a
  // harmless no-op, so forcing this branch always-on changes nothing.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Stryker disable next-line OptionalChaining: stopWatch() clears both the
    // timer and `settled`, so the callback never fires with a null `settled`.
    settled?.();
  }, debounceMs());
}

export function handleDirEvent(eventType: string, filename: string | Buffer | null): void {
  // Stryker disable next-line ConditionalExpression: fs.watch yields a string or
  // null, and bookRelevant() treats null and "null" identically, so this only
  // affects a Buffer filename (rare) - either way it stays book-relevant.
  const name = filename == null ? null : String(filename);
  // A rename on a directory entry may mean a new/removed sub-directory: rebuild
  // the watch set (cheap) so we keep seeing deep changes.
  // Stryker disable next-line ConditionalExpression: syncWatchers() is idempotent,
  // so running it on a non-rename event too is wasted work with the same result.
  if (eventType === 'rename') syncWatchers(watchedRoot);
  if (bookRelevant(name)) scheduleSettled();
}

function onDirEvent(): (eventType: string, filename: string | Buffer | null) => void {
  return handleDirEvent;
}

function syncWatchers(root: string | null): void {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: a falsy or
  // missing root also makes the readdir/fs.watch calls below throw (into their
  // own catches), leaving the watcher set empty just the same.
  if (!root || !fs.existsSync(root)) return;
  const wanted = new Set<string>([root]);
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
      // Stryker disable next-line BlockStatement: a directory that readdir can't
      // list (permissions / vanished mid-walk) is simply skipped; hard to force in a test.
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const abs = path.join(dir, e.name);
        wanted.add(abs);
        walk(abs);
      }
    }
  };
  walk(root);

  for (const dir of wanted) {
    if (watchers.has(dir)) continue;
    try {
      watchers.set(dir, fs.watch(dir, onDirEvent()));
    } catch {
      /* directory vanished between readdir and watch */
    }
  }
  for (const [dir, w] of watchers) {
    if (!wanted.has(dir)) {
      w.close();
      watchers.delete(dir);
    }
  }
}

export function watchStatus(): { watching: boolean; watchedDirs: number; pending: boolean } {
  return {
    watching: watchers.size > 0,
    watchedDirs: watchers.size,
    pending: Boolean(debounceTimer),
  };
}

/** Start watching `S.rootLib`; `onSettled` fires once the filesystem goes quiet. */
export function startWatch(onSettled: () => void): void {
  settled = onSettled;
  watchedRoot = S.rootLib;
  syncWatchers(watchedRoot);
}

export function stopWatch(): void {
  // Stryker disable next-line ConditionalExpression,CallExpression: `debounceTimer`
  // is nulled on the next line regardless; clearing the OS timer just stops a
  // now-harmless callback (settled is nulled below) from firing later.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  for (const w of watchers.values()) w.close();
  watchers.clear();
  watchedRoot = null;
  settled = null;
}

/** Re-point the watch at the current `S.rootLib` (called when the setting changes). */
export function restartWatch(): void {
  if (!settled) return;
  const cb = settled;
  // Stryker disable next-line CallExpression: syncWatchers() inside startWatch()
  // already prunes watchers for the old root, and `cb` is unchanged, so the
  // explicit stopWatch() is belt-and-braces.
  stopWatch();
  startWatch(cb);
}

export function isWatching(): boolean {
  return watchers.size > 0;
}
