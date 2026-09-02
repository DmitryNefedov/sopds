import { S, cronMatches, getState, setState, onChange } from './settings.js';
import { scan } from './scanner.js';

// Minute-resolution scheduler for automatic collection scans, driven by the
// `scanEnabled` / `scanCron` settings.

let timer = null;
let running = false;
let lastTickMinute = null;
const doneListeners = new Set();

export function isScanning() {
  return running;
}

// Register a callback fired after every scan completes (used by the watcher).
export function onScanDone(fn) {
  doneListeners.add(fn);
  return () => doneListeners.delete(fn);
}

export function scanState() {
  return {
    running,
    enabled: S.scanEnabled,
    cron: S.scanCron,
    watching: S.watchEnabled,
    last: getState('lastScan'),
    nextCheck: timer ? 'within 60s' : null,
  };
}

export async function runScan({ reason = 'manual', root } = {}) {
  if (running) return { skipped: true, reason: 'a scan is already running' };
  running = true;
  const startedAt = new Date().toISOString();
  let record;
  try {
    const result = await Promise.resolve().then(() =>
      scan({ log: () => {}, root }),
    );
    record = { startedAt, finishedAt: new Date().toISOString(), reason, ...result };
  } catch (err) {
    record = { startedAt, finishedAt: new Date().toISOString(), reason, error: err.message };
  } finally {
    running = false;
  }
  setState('lastScan', record);
  for (const fn of doneListeners) {
    try {
      fn(record);
    } catch {
      /* ignore */
    }
  }
  return record;
}

function tick() {
  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (minuteKey === lastTickMinute) return; // guard against double fire
  lastTickMinute = minuteKey;

  if (!S.scanEnabled || running) return;
  if (cronMatches(S.scanCron, now)) {
    runScan({ reason: 'schedule' });
  }
}

export function startScheduler() {
  if (timer) return;
  // align-ish to the top of each minute, then every 60s
  timer = setInterval(tick, 30_000);
  tick();
  onChange((patch) => {
    if ('scanCron' in patch || 'scanEnabled' in patch) lastTickMinute = null;
  });
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
