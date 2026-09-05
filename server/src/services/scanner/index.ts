import { S, onChange, getState, setState } from '../settings.js';
import { runOnce } from './engine.js';
import { startSchedule, stopSchedule, resetSchedule } from './schedule.js';
import { startWatch, stopWatch, restartWatch, watchStatus, isWatching } from './watch.js';
import type { ScanRecord, ScanStatus } from '../../types.js';

// The Scanner owns Scan: it funnels every trigger (manual, scheduled, watch)
// through one concurrency mutex, holds the run/progress/last-run state, and
// starts and stops the schedule tick and folder watch as one lifecycle. The raw
// walk is `engine.ts` `runOnce`, which the CLI and tests call directly.

let running = false;
let progress: { added: number; skipped: number } | null = null;
let pendingReason: string | null = null;
let wired = false;

async function run(reason: string): Promise<void> {
  running = true;
  progress = { added: 0, skipped: 0 };
  const startedAt = new Date().toISOString();
  let record: ScanRecord;
  try {
    const result = await runOnce({
      log: () => {},
      onProgress: (p) => {
        progress = p;
      },
    });
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
    progress = null;
  }
  await setState('lastScan', record);

  if (pendingReason) {
    const next = pendingReason;
    pendingReason = null;
    void run(next);
  }
}

export const Scanner = {
  /**
   * Request a scan. Runs immediately when idle; otherwise queues exactly one
   * follow-up run (the most recent reason wins) that fires when the current one
   * finishes.
   */
  trigger(reason: string): { started: boolean; queued: boolean } {
    if (running) {
      pendingReason = reason;
      return { started: false, queued: true };
    }
    void run(reason);
    return { started: true, queued: false };
  },

  status(): ScanStatus {
    return {
      running,
      progress: running ? progress : null,
      last: getState<ScanRecord>('lastScan'),
      enabled: S.scanEnabled,
      cron: S.scanCron,
      watch: watchStatus(),
    };
  },

  /** Start the schedule tick and the folder watch, and react to setting changes. */
  start(): void {
    startSchedule(() => Scanner.trigger('schedule'));
    if (S.watchEnabled) startWatch(() => Scanner.trigger('watch'));

    if (!wired) {
      wired = true;
      onChange((patch) => {
        if ('watchEnabled' in patch) {
          if (S.watchEnabled) startWatch(() => Scanner.trigger('watch'));
          else stopWatch();
        } else if ('rootLib' in patch && isWatching()) {
          restartWatch();
        }
        if ('scanCron' in patch || 'scanEnabled' in patch) resetSchedule();
      });
    }
  },

  stop(): void {
    stopSchedule();
    stopWatch();
  },
};
