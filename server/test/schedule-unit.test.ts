import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SOPDS_TEST_DB ??= 'mem';

const { tick, minuteKey, startSchedule, stopSchedule, resetSchedule } = await import('../src/services/scanner/schedule.js');
const { setOverride } = await import('../src/services/settings.js');

// The minute-resolution cron tick. `tick()` is pure given the settings + clock;
// startSchedule wires it to a 30s interval.

function withSettings(over: Record<string, unknown>, fn: () => void) {
  for (const [k, v] of Object.entries(over)) setOverride(k as never, v);
  try {
    fn();
  } finally {
    for (const k of Object.keys(over)) setOverride(k as never, undefined as never);
    resetSchedule();
  }
}

test('minuteKey gives distinct minutes distinct keys (no h:m digit collision)', () => {
  // 01:23 and 12:03 would collide if the separators were dropped.
  const a = minuteKey(new Date(2024, 0, 1, 1, 23));
  const b = minuteKey(new Date(2024, 0, 1, 12, 3));
  assert.notEqual(a, b);
  assert.equal(minuteKey(new Date(2024, 0, 1, 1, 23, 5)), minuteKey(new Date(2024, 0, 1, 1, 23, 55)), 'same minute -> same key');
  assert.notEqual(minuteKey(new Date(2024, 0, 1, 1, 23)), minuteKey(new Date(2024, 0, 2, 1, 23)), 'different day');
  assert.notEqual(minuteKey(new Date(2024, 0, 1, 1, 23)), minuteKey(new Date(2024, 1, 1, 1, 23)), 'different month');
  assert.notEqual(minuteKey(new Date(2024, 0, 1, 1, 23)), minuteKey(new Date(2025, 0, 1, 1, 23)), 'different year');
});

test('tick fires onDue when scanning is enabled and the cron matches the given time', () => {
  resetSchedule();
  withSettings({ scanEnabled: true, scanCron: '23 1 * * *' }, () => {
    let due = 0;
    tick(() => { due += 1; }, new Date(2024, 0, 1, 1, 23));
    assert.equal(due, 1);
    tick(() => { due += 1; }, new Date(2024, 0, 1, 1, 24));
    assert.equal(due, 1, 'a different minute that does not match the cron');
  });
});

test('tick does not fire when scanning is disabled', () => {
  resetSchedule();
  withSettings({ scanEnabled: false, scanCron: '* * * * *' }, () => {
    let due = 0;
    tick(() => { due += 1; });
    assert.equal(due, 0);
  });
});

test('tick does not fire when the cron does not match this minute', () => {
  resetSchedule();
  // A cron that can never match (minute 61 is out of range -> cronMatches false).
  withSettings({ scanEnabled: true, scanCron: '0 0 31 2 *' }, () => {
    let due = 0;
    tick(() => { due += 1; });
    assert.equal(due, 0, 'Feb 31 never happens');
  });
});

test('tick de-duplicates within the same minute, until resetSchedule', () => {
  resetSchedule();
  withSettings({ scanEnabled: true, scanCron: '* * * * *' }, () => {
    let due = 0;
    const onDue = () => { due += 1; };
    tick(onDue);
    tick(onDue);
    tick(onDue);
    assert.equal(due, 1, 'the 30s interval double-firing within a minute is a single onDue');

    resetSchedule();
    tick(onDue);
    assert.equal(due, 2, 'resetSchedule clears the last-tick minute so the next tick re-evaluates');
  });
});

test('startSchedule ticks immediately, is idempotent, and stopSchedule tears it down', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  resetSchedule();
  try {
    withSettings({ scanEnabled: true, scanCron: '* * * * *' }, () => {
      let due = 0;
      startSchedule(() => { due += 1; });
      assert.equal(due, 1, 'an immediate tick on start');

      startSchedule(() => { due += 100; });
      assert.equal(due, 1, 'a second startSchedule is a no-op (timer already set)');

      resetSchedule();
      t.mock.timers.tick(30_000);
      assert.equal(due, 2, 'the 30s interval fired another tick');

      stopSchedule();
      resetSchedule();
      t.mock.timers.tick(60_000);
      assert.equal(due, 2, 'no more ticks after stopSchedule');
    });
  } finally {
    stopSchedule();
    t.mock.timers.reset();
  }
});
