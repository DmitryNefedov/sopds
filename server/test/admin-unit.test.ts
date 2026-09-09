import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSetting, settingsErrorResponse } from '../src/routes/admin.js';
import { SETTING_DEFS, SettingsError } from '../src/services/settings.js';
import type { SettingDef } from '../src/services/settings.js';

const def = (over: Partial<SettingDef>): SettingDef =>
  ({ key: 'title', group: 'General', type: 'text', default: '', label: 'L', ...over }) as SettingDef;

// ---- describeSetting ----------------------------------------------

test('describeSetting carries label/type/default straight through', () => {
  const d = describeSetting(def({ key: 'maxItems', type: 'int', default: 20, label: 'Items per page' }));
  assert.equal(d.key, 'maxItems');
  assert.equal(d.label, 'Items per page');
  assert.equal(d.type, 'int');
  assert.equal(d.default, 20);
});

test('describeSetting: help is the string when set, null when absent or empty', () => {
  assert.equal(describeSetting(def({ help: 'Do the thing' })).help, 'Do the thing');
  assert.equal(describeSetting(def({ help: undefined })).help, null);
  assert.equal(describeSetting(def({ help: '' })).help, null);
});

test('describeSetting: min/max are the numbers when set, null when absent (including 0)', () => {
  const bounded = describeSetting(def({ min: 0, max: 64 }));
  assert.deepEqual([bounded.min, bounded.max], [0, 64], '0 is a real bound, not treated as absent');
  const unbounded = describeSetting(def({ min: undefined, max: undefined }));
  assert.deepEqual([unbounded.min, unbounded.max], [null, null]);
});

test('describeSetting round-trips every real setting into a complete descriptor', () => {
  for (const raw of SETTING_DEFS) {
    const d = describeSetting(raw);
    assert.equal(d.key, raw.key);
    assert.equal(d.help, raw.help || null);
    assert.equal(d.min, raw.min ?? null);
    assert.equal(d.max, raw.max ?? null);
  }
});

// ---- settingsErrorResponse -------------------------------------

test('settingsErrorResponse: a SettingsError keeps its status and per-field detail', () => {
  const err = new SettingsError({ scanCron: 'invalid cron expression (expected 5 fields)' });
  assert.deepEqual(settingsErrorResponse(err), {
    status: 400,
    body: { error: 'invalid settings', fields: { scanCron: 'invalid cron expression (expected 5 fields)' } },
  });
  // status is taken from the error, not hard-coded
  const custom = new SettingsError({});
  custom.status = 422;
  assert.equal(settingsErrorResponse(custom).status, 422);
});

test('settingsErrorResponse: any other error becomes a plain 400 with null fields', () => {
  assert.deepEqual(settingsErrorResponse(new Error('database is on fire')), {
    status: 400,
    body: { error: 'database is on fire', fields: null },
  });
});
