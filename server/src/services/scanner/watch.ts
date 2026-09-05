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

function bookRelevant(name: string | null): boolean {
  // directories have no extension; treat "no ext" as a possible dir event
  return !name || !path.extname(name) || BOOK_LIKE.test(name);
}

function scheduleSettled(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  const wait = Math.max(1, Number(S.watchDebounce) || 5) * 1000;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    settled?.();
  }, wait);
}

function onDirEvent(): (eventType: string, filename: string | Buffer | null) => void {
  return (eventType, filename) => {
    const name = typeof filename === 'string' ? filename : filename ? filename.toString() : null;
    // A rename on a directory entry may mean a new/removed sub-directory:
    // rebuild the watch set (cheap) so we keep seeing deep changes.
    if (eventType === 'rename') syncWatchers(watchedRoot);
    if (bookRelevant(name)) scheduleSettled();
  };
}

function syncWatchers(root: string | null): void {
  if (!root || !fs.existsSync(root)) return;
  const wanted = new Set<string>([root]);
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
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
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  for (const w of watchers.values()) w.close();
  watchers.clear();
  watchedRoot = null;
}

/** Re-point the watch at the current `S.rootLib` (called when the setting changes). */
export function restartWatch(): void {
  if (!settled) return;
  const cb = settled;
  stopWatch();
  startWatch(cb);
}

export function isWatching(): boolean {
  return watchers.size > 0;
}
