import { S } from '../settings.js';
import { cronMatches } from '../cron.js';

// The minute-resolution cron tick. Owns only "is now a scheduled time?" — it
// calls `onDue()` and the Scanner decides what to do with the trigger.

let timer: NodeJS.Timeout | null = null;
let lastTickMinute: string | null = null;

function tick(onDue: () => void): void {
  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (minuteKey === lastTickMinute) return; // guard against the 30s interval double-firing
  lastTickMinute = minuteKey;
  if (!S.scanEnabled) return;
  if (cronMatches(S.scanCron, now)) onDue();
}

export function startSchedule(onDue: () => void): void {
  if (timer) return;
  timer = setInterval(() => tick(onDue), 30_000);
  tick(onDue);
}

export function stopSchedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastTickMinute = null;
}

/** Re-evaluate on the next tick after `scanCron` / `scanEnabled` changed. */
export function resetSchedule(): void {
  lastTickMinute = null;
}

export function isScheduled(): boolean {
  return timer !== null;
}
