import { S } from '../settings.js';
import { cronMatches } from '../../utils/cron.js';

// The minute-resolution cron tick. Owns only "is now a scheduled time?" — it
// calls `onDue()` and the Scanner decides what to do with the trigger.

let timer: NodeJS.Timeout | null = null;
let lastTickMinute: string | null = null;

/** A stable key for the minute `d` falls in (distinct minutes never collide). */
export function minuteKey(d: Date): string {
  return [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()].join(':');
}

export function tick(onDue: () => void, now: Date = new Date()): void {
  const key = minuteKey(now);
  if (key === lastTickMinute) return; // guard against the 30s interval double-firing
  lastTickMinute = key;
  if (!S.scanEnabled) return;
  if (cronMatches(S.scanCron, now)) onDue();
}

export function startSchedule(onDue: () => void): void {
  if (timer) return;
  timer = setInterval(() => tick(onDue), 30_000);
  tick(onDue);
}

export function stopSchedule(): void {
  // Stryker disable next-line ConditionalExpression: `timer` is nulled next line
  // regardless; clearInterval(null) is a harmless no-op.
  if (timer) clearInterval(timer);
  timer = null;
  lastTickMinute = null;
}

/** Re-evaluate on the next tick after `scanCron` / `scanEnabled` changed. */
export function resetSchedule(): void {
  lastTickMinute = null;
}
