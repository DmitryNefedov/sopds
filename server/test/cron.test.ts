import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidCron, cronMatches } from '../src/utils/cron.js';

// Five-field cron (minute hour day-of-month month day-of-week), used by settings
// validation of `scanCron` and by the scheduler's minute tick.

test('isValidCron requires exactly five whitespace-separated fields', () => {
  assert.equal(isValidCron('0 0 1 1 0'), true);
  assert.equal(isValidCron('0 0 1 1'), false, 'four fields');
  assert.equal(isValidCron('0 0 1 1 0 0'), false, 'six fields');
  assert.equal(isValidCron(''), false);
  assert.equal(isValidCron('     '), false, 'only whitespace');
});

test('isValidCron tolerates surrounding and repeated whitespace', () => {
  assert.equal(isValidCron('  0 0 1 1 0  '), true, 'leading/trailing trimmed');
  assert.equal(isValidCron('0\t0 1 1 0'), true, 'tab counts as a separator');
  assert.equal(isValidCron('0   0   1   1   0'), true, 'runs of spaces collapse');
});

test('isValidCron accepts *, lists, ranges and steps within range', () => {
  assert.equal(isValidCron('* * * * *'), true);
  assert.equal(isValidCron('0,15,30,45 * * * *'), true, 'list');
  assert.equal(isValidCron('0-59 0-23 1-31 1-12 0-7 '.trim()), true, 'full ranges');
  assert.equal(isValidCron('*/15 */2 */2 */3 */2'), true, 'steps on every field');
  assert.equal(isValidCron('1-5/2 * * * *'), true, 'range with a step');
});

test('isValidCron rejects a field value outside its range', () => {
  assert.equal(isValidCron('60 * * * *'), false, 'minute max is 59');
  assert.equal(isValidCron('* 24 * * *'), false, 'hour max is 23');
  assert.equal(isValidCron('* * 0 * *'), false, 'day-of-month min is 1');
  assert.equal(isValidCron('* * 32 * *'), false);
  assert.equal(isValidCron('* * * 0 *'), false, 'month min is 1');
  assert.equal(isValidCron('* * * 13 *'), false);
  assert.equal(isValidCron('* * * * 8'), false, 'day-of-week max is 7');
});

test('isValidCron rejects a range whose endpoints leave the field range', () => {
  assert.equal(isValidCron('0-60 * * * *'), false, 'range end past max');
  assert.equal(isValidCron('5-1 * * * *'), true, 'inverted range is still in-range syntactically');
  assert.equal(isValidCron('* * 0-5 * *'), false, 'range start below min');
  assert.equal(isValidCron('* * 5-0 * *'), false, 'range end below min (day-of-month)');
  assert.equal(isValidCron('* * 5-1 * *'), true, 'range end at exactly the min is fine');
});

test('isValidCron checks every token of a comma list, not just one', () => {
  assert.equal(isValidCron('0,60 * * * *'), false, 'second token out of range');
  assert.equal(isValidCron('60,0 * * * *'), false, 'first token out of range');
  assert.equal(isValidCron('0,15,99 * * * *'), false, 'a later token out of range');
});

test('isValidCron checks every field, not just the first', () => {
  assert.equal(isValidCron('0 99 99 99 99'), false, 'first field valid, the rest are not');
});

test('isValidCron rejects non-numeric or partially-numeric field tokens', () => {
  assert.equal(isValidCron('x * * * *'), false);
  assert.equal(isValidCron('5x * * * *'), false, 'trailing junk (needs full ^\\d+$ match)');
  assert.equal(isValidCron('x5 * * * *'), false, 'leading junk');
  assert.equal(isValidCron('5-x * * * *'), false, 'range end non-numeric');
  assert.equal(isValidCron('5-5x * * * *'), false, 'range end with trailing junk');
  assert.equal(isValidCron('5-x5 * * * *'), false, 'range end with leading junk');
  assert.equal(isValidCron('5- * * * *'), false, 'empty range end is not a number');
});

test('isValidCron validates the step token itself', () => {
  assert.equal(isValidCron('*/0 * * * *'), false, 'step must be >= 1');
  assert.equal(isValidCron('*/1 * * * *'), true, 'step of exactly 1 is allowed');
  assert.equal(isValidCron('*/x * * * *'), false, 'step must be numeric');
  assert.equal(isValidCron('*/2x * * * *'), false, 'step with trailing junk');
  assert.equal(isValidCron('*/x2 * * * *'), false, 'step with leading junk (needs a ^ anchor)');
  assert.equal(isValidCron('*/-1 * * * *'), false, 'negative step');
});

test('cronMatches returns false for an invalid expression', () => {
  assert.equal(cronMatches('nonsense', new Date('2024-01-08T00:00:00')), false);
  assert.equal(cronMatches('0 0 1 1', new Date('2024-01-08T00:00:00')), false);
  // Four all-wildcard fields would "match" any date if the validity guard were
  // skipped, so this pins that the guard actually runs.
  assert.equal(cronMatches('* * * *', new Date('2024-01-08T00:00:00')), false);
});

test('cronMatches trims and collapses whitespace before splitting fields', () => {
  const at = new Date('2024-01-08T09:30:00');
  assert.equal(cronMatches(' 30 * * * * ', at), true, 'surrounding whitespace ignored');
  assert.equal(cronMatches('30  *  *  *  *', at), true, 'runs of spaces collapse');
});

test('cronMatches checks minute, hour, day, month and weekday together', () => {
  const monday0900 = new Date('2024-01-08T09:00:00'); // Mon, 8 Jan
  assert.equal(cronMatches('0 9 8 1 1', monday0900), true, 'every field lines up');
  assert.equal(cronMatches('1 9 8 1 1', monday0900), false, 'minute off');
  assert.equal(cronMatches('0 10 8 1 1', monday0900), false, 'hour off');
  assert.equal(cronMatches('0 9 9 1 1', monday0900), false, 'day-of-month off');
  assert.equal(cronMatches('0 9 8 2 1', monday0900), false, 'month off');
  assert.equal(cronMatches('0 9 8 1 2', monday0900), false, 'weekday off');
});

test('cronMatches maps the month to 1-12, not 0-11', () => {
  const march = new Date('2024-03-08T09:00:00');
  assert.equal(cronMatches('0 9 8 3 *', march), true, 'March is month 3');
  assert.equal(cronMatches('0 9 8 2 *', march), false, 'not month 2');
});

test('cronMatches honours * as "any value"', () => {
  const d = new Date('2024-01-08T09:30:00');
  assert.equal(cronMatches('* * * * *', d), true);
  assert.equal(cronMatches('30 * * * *', d), true, 'minute pinned, rest any');
  assert.equal(cronMatches('29 * * * *', d), false);
});

test('cronMatches walks a range by its step', () => {
  assert.equal(cronMatches('*/15 * * * *', new Date('2024-01-08T09:30:00')), true);
  assert.equal(cronMatches('*/15 * * * *', new Date('2024-01-08T09:31:00')), false);
  assert.equal(cronMatches('0-30/10 * * * *', new Date('2024-01-08T09:20:00')), true);
  assert.equal(cronMatches('0-30/10 * * * *', new Date('2024-01-08T09:25:00')), false);
  assert.equal(cronMatches('0-30/10 * * * *', new Date('2024-01-08T09:40:00')), false, 'past the range end');
});

test('cronMatches treats a bare number as a one-value range', () => {
  assert.equal(cronMatches('7 * * * *', new Date('2024-01-08T09:07:00')), true);
  assert.equal(cronMatches('7 * * * *', new Date('2024-01-08T09:08:00')), false);
});

test('cronMatches accepts a comma list where any element hits', () => {
  const d = new Date('2024-01-08T12:00:00');
  assert.equal(cronMatches('0 0,6,12,18 * * *', d), true);
  assert.equal(cronMatches('0 0,6,18 * * *', d), false);
});

test('cronMatches accepts Sunday as either 0 or 7', () => {
  const sunday = new Date('2024-01-07T04:00:00'); // Sunday
  assert.equal(sunday.getDay(), 0);
  assert.equal(cronMatches('0 4 * * 0', sunday), true, 'weekday written as 0');
  assert.equal(cronMatches('0 4 * * 7', sunday), true, 'weekday written as 7');
  assert.equal(cronMatches('0 4 * * 7-7', sunday), true, 'range 7-7 also means Sunday');
  assert.equal(cronMatches('0 4 * * 3', sunday), false, 'Sunday is not weekday 3');
  const monday = new Date('2024-01-08T04:00:00');
  assert.equal(cronMatches('0 4 * * 0', monday), false, 'Monday is not Sunday');
  assert.equal(cronMatches('0 4 * * 7', monday), false);
});

test('the 0<->7 Sunday fix is scoped to the day-of-week field only', () => {
  // A cron hour of 7 must not match midnight just because 0 and 7 are special
  // for weekdays; the `idx === 4` guard keeps that logic on field 4.
  const sundayMidnight = new Date('2024-01-07T00:00:00');
  assert.equal(sundayMidnight.getHours(), 0);
  assert.equal(cronMatches('0 7 * * *', sundayMidnight), false, 'hour 0 is not hour 7');
});

test('cronMatches defaults its date argument to now', () => {
  // "* * * * *" matches every minute, so it must be true regardless of the clock.
  assert.equal(cronMatches('* * * * *'), true);
});
