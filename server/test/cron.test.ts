import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidCron, cronMatches } from '../src/cron.js';

test('cron matching honours fields, lists, ranges and steps', () => {
  const at = (s: string) => new Date(`2024-01-08T${s}:00`); // Monday
  assert.ok(cronMatches('0 0,12 * * *', at('12:00')));
  assert.ok(!cronMatches('0 0,12 * * *', at('13:00')));
  assert.ok(cronMatches('*/15 * * * *', at('09:30')));
  assert.ok(!cronMatches('*/15 * * * *', at('09:31')));
  assert.ok(cronMatches('0 4 * * 1', at('04:00'))); // Monday
  assert.ok(!cronMatches('0 4 * * 2', at('04:00')));
});

test('isValidCron guards field counts and ranges', () => {
  assert.ok(isValidCron('0 0 1 1 0'));
  assert.ok(!isValidCron('0 0 1 1'));
  assert.ok(!isValidCron('99 0 1 1 0'));
});
