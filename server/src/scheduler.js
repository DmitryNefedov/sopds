import { S, cronMatches, getState, setState, onChange } from './settings.js';
import { scan } from './scanner.js';

// Minute-resolution scheduler for automatic collection scans, driven by the
// `scanEnabled` / `scanCron` settings.

let timer = null;
let running = false;
let lastTickMinute = null;

export function scanState() {
  return {
    running,
    enabled: S.scanEnabled,
    cron: S.scanCron,
    last: getState('lastScan'),
    nextCheck: timer ? 'within 60s' : null,
  };
}

export async function runScan({ reason = 'manual', root } = {}) {
  if (running) return { skipped: true, reason: 'a scan is already running' };
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const result = await Promise.resolve().then(() =>
      scan({ log: () => {}, root }),
    );
    const record = { startedAt, finishedAt: new Date().toISOString(), reason, ...result };
    setState('lastScan', record);
    return record;
  } catch (err) {
    const record = { startedAt, finishedAt: new Date().toISOString(), reason, error: err.message };
    setState('lastScan', record);
    return record;
  } finally {
    running = false;
  }
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
