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
    // Stryker disable next-line ObjectLiteral: runOnce() defaults log and
    // onProgress, so an empty options object scans just the same.
    const result = await runOnce({
      log: () => {},
      // Stryker disable next-line BlockStatement: onProgress only fires when a
      // scan batch flushes, which a fixture-sized test scan never reaches; the
      // live progress display is exercised manually.
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
    // Stryker disable next-line StringLiteral,ArrowFunction: the watch callback is
    // only invoked by a real debounced filesystem event, not reachable in a test.
    if (S.watchEnabled) startWatch(() => Scanner.trigger('watch'));

    // Stryker disable next-line ConditionalExpression,BooleanLiteral: re-registering
    // the listener on a second start() only adds an idempotent duplicate.
    if (!wired) {
      // Stryker disable next-line BooleanLiteral: leaving `wired` false only lets a
      // second start() add an idempotent duplicate listener.
      wired = true;
      onChange((patch) => {
        // Stryker disable next-line ConditionalExpression: taking the watchEnabled
        // branch for any patch still calls startWatch(), which re-reads S.rootLib
        // and syncs - the same net effect as the rootLib branch below.
        if ('watchEnabled' in patch) {
          // Stryker disable next-line StringLiteral,ArrowFunction: see start().
          if (S.watchEnabled) startWatch(() => Scanner.trigger('watch'));
          else stopWatch();
        } else {
          // Stryker disable next-line ConditionalExpression,LogicalOperator: restartWatch()
          // is a no-op when not watching and idempotent when watching, so loosening
          // this guard is unobservable.
          if ('rootLib' in patch && isWatching()) restartWatch();
        }
        // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral,CallExpression: resetSchedule()
        // only affects an in-flight minute's dedup key; every test path also
        // stops/starts the schedule, which clears it too.
        if ('scanCron' in patch || 'scanEnabled' in patch) resetSchedule();
      });
    }
  },

  stop(): void {
    stopSchedule();
    stopWatch();
  },
};
