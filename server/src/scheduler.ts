import { S, cronMatches, getState, setState, onChange } from './settings.js';
import { scan } from './scanner.js';
import type { ScanStats } from './types.js';

// Minute-resolution scheduler for automatic collection scans, driven by the
// `scanEnabled` / `scanCron` settings.

export interface ScanRecord extends Partial<ScanStats> {
  startedAt: string;
  finishedAt: string;
  reason: string;
  error?: string;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastTickMinute: string | null = null;
const doneListeners = new Set<(rec: ScanRecord) => void>();

export function isScanning(): boolean {
  return running;
}

// Register a callback fired after every scan completes (used by the watcher).
export function onScanDone(fn: (rec: ScanRecord) => void): () => void {
  doneListeners.add(fn);
  return () => doneListeners.delete(fn);
}

export interface ScanState {
  running: boolean;
  enabled: boolean;
  cron: string;
  watching: boolean;
  last: ScanRecord | null;
  nextCheck: string | null;
}

export function scanState(): ScanState {
  return {
    running,
    enabled: S.scanEnabled,
    cron: S.scanCron,
    watching: S.watchEnabled,
    last: getState<ScanRecord>('lastScan'),
    nextCheck: timer ? 'within 60s' : null,
  };
}

export interface RunScanOpts {
  reason?: string;
  root?: string;
}

export async function runScan({
  reason = 'manual',
  root,
}: RunScanOpts = {}): Promise<ScanRecord | { skipped: true; reason: string }> {
  if (running) return { skipped: true, reason: 'a scan is already running' };
  running = true;
  const startedAt = new Date().toISOString();
  let record: ScanRecord;
  try {
    const result = await scan({ log: () => {}, root });
    record = { startedAt, finishedAt: new Date().toISOString(), reason, ...result };
  } catch (err) {
    record = {
      startedAt,
      finishedAt: new Date().toISOString(),
      reason,
      error: (err as Error).message,
    };
  } finally {
    running = false;
  }
  await setState('lastScan', record);
  for (const fn of doneListeners) {
    try {
      fn(record);
    } catch {
      /* ignore */
    }
  }
  return record;
}

function tick(): void {
  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (minuteKey === lastTickMinute) return; // guard against double fire
  lastTickMinute = minuteKey;

  if (!S.scanEnabled || running) return;
  if (cronMatches(S.scanCron, now)) {
    void runScan({ reason: 'schedule' });
  }
}

export function startScheduler(): void {
  if (timer) return;
  // align-ish to the top of each minute, then every 60s
  timer = setInterval(tick, 30_000);
  tick();
  onChange((patch) => {
    if ('scanCron' in patch || 'scanEnabled' in patch) lastTickMinute = null;
  });
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
