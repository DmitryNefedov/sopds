import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-settings-'));
process.env.SOPDS_DB = path.join(tmp, 'test.db');

const settings = await import('../src/settings.js');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('defaults are returned before anything is stored', () => {
  assert.equal(settings.get('maxItems'), settings.SETTING_DEFS.find((d) => d.key === 'maxItems').default);
  assert.equal(typeof settings.get('doublesHide'), 'boolean');
});

test('setMany persists and coerces types', () => {
  settings.setMany({ maxItems: '17', doublesHide: 'false', title: 'X' });
  assert.equal(settings.get('maxItems'), 17);
  assert.equal(settings.get('doublesHide'), false);
  assert.equal(settings.get('title'), 'X');
});

test('setMany clamps ints to the declared range', () => {
  settings.setMany({ maxItems: 9999 });
  assert.equal(settings.get('maxItems'), 200);
});

test('invalid cron is rejected with a field error', () => {
  assert.throws(
    () => settings.setMany({ scanCron: 'not a cron' }),
    (err) => Boolean(err.fields && err.fields.scanCron),
  );
});

test('unknown keys are rejected', () => {
  assert.throws(() => settings.setMany({ nope: 1 }), /invalid settings/);
});

test('onChange fires with the patched keys', () => {
  let seen = null;
  const off = settings.onChange((patch) => {
    seen = patch;
  });
  settings.setMany({ zipScan: false });
  off();
  assert.deepEqual(Object.keys(seen), ['zipScan']);
});

test('cron matching honours fields, lists, ranges and steps', () => {
  const at = (s) => new Date(`2024-01-08T${s}:00`); // Monday
  assert.ok(settings.cronMatches('0 0,12 * * *', at('12:00')));
  assert.ok(!settings.cronMatches('0 0,12 * * *', at('13:00')));
  assert.ok(settings.cronMatches('*/15 * * * *', at('09:30')));
  assert.ok(!settings.cronMatches('*/15 * * * *', at('09:31')));
  assert.ok(settings.cronMatches('0 4 * * 1', at('04:00'))); // Monday
  assert.ok(!settings.cronMatches('0 4 * * 2', at('04:00')));
});

test('isValidCron guards field counts and ranges', () => {
  assert.ok(settings.isValidCron('0 0 1 1 0'));
  assert.ok(!settings.isValidCron('0 0 1 1'));
  assert.ok(!settings.isValidCron('99 0 1 1 0'));
});
