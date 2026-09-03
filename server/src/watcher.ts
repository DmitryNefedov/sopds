import fs from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'node:fs';
import { S, onChange } from './settings.js';
import { runScan, onScanDone } from './scheduler.js';

// On-demand scanning: watch the book collection folder and trigger an
// incremental rescan a few seconds after the filesystem goes quiet.
//
// A manual recursive watcher (watch the root + every sub-directory) is used so
// behaviour is identical on macOS, Linux and Windows.

const watchers = new Map<string, FSWatcher>(); // absolute dir -> fs.FSWatcher
let debounceTimer: NodeJS.Timeout | null = null;
let queued = false; // a change arrived while a scan was running
let active = false;
let watchedRoot: string | null = null;

const BOOK_LIKE = /\.(fb2|epub|mobi|pdf|djvu|zip)$/i;

function bookRelevant(name: string | null): boolean {
  // directories have no extension; treat "no ext" as a possible dir event
  return !name || !path.extname(name) || BOOK_LIKE.test(name);
}

function scheduleScan(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  const wait = Math.max(1, Number(S.watchDebounce) || 5) * 1000;
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    const res = await runScan({ reason: 'watch' });
    if (res && 'skipped' in res && res.skipped) queued = true; // scan was busy; retry after it ends
  }, wait);
}

function onDirEvent(_dir: string): (eventType: string, filename: string | Buffer | null) => void {
  return (eventType, filename) => {
    const name = typeof filename === 'string' ? filename : filename ? filename.toString() : null;
    // A rename on a directory entry may mean a new/removed sub-directory:
    // rebuild the watch set (cheap) so we keep seeing deep changes.
    if (eventType === 'rename') syncWatchers(watchedRoot);
    if (bookRelevant(name)) scheduleScan();
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

  // add new
  for (const dir of wanted) {
    if (watchers.has(dir)) continue;
    try {
      watchers.set(dir, fs.watch(dir, onDirEvent(dir)));
    } catch {
      /* directory vanished between readdir and watch */
    }
  }
  // drop gone
  for (const [dir, w] of watchers) {
    if (!wanted.has(dir)) {
      w.close();
      watchers.delete(dir);
    }
  }
}

export function watcherState() {
  // returned as-is to the admin API
  return {
    enabled: S.watchEnabled,
    watching: watchers.size > 0,
    root: watchedRoot,
    watchedDirs: watchers.size,
    pending: Boolean(debounceTimer),
    debounceSeconds: Number(S.watchDebounce) || 5,
  };
}

export function startWatcher(): void {
  if (active) return;
  active = true;

  onScanDone(() => {
    if (queued) {
      queued = false;
      scheduleScan();
    }
  });

  onChange((patch) => {
    if ('watchEnabled' in patch) {
      if (S.watchEnabled) enable();
      else disable();
    } else if ('rootLib' in patch && watchers.size) {
      disable();
      enable();
    } else if ('watchDebounce' in patch && debounceTimer) {
      scheduleScan(); // re-arm with the new delay
    }
  });

  if (S.watchEnabled) enable();
}

function enable(): void {
  watchedRoot = S.rootLib;
  syncWatchers(watchedRoot);
}

function disable(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  for (const w of watchers.values()) w.close();
  watchers.clear();
}

export function stopWatcher(): void {
  disable();
  active = false;
}
