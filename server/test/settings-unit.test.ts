import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coerce,
  get,
  getAll,
  setOverride,
  getState,
  onChange,
  S,
  SettingsError,
  SETTING_DEFS,
  type SettingDef,
} from '../src/services/settings.js';

// coerce() and the synchronous read surface (get / getAll / S / getState) all
// work off defaults + the override map with no database. setMany / setState /
// loadSettings are DB-backed and live in settings.test.ts.

const def = (over: Partial<SettingDef>): SettingDef => ({
  key: 'title',
  group: 'General',
  type: 'text',
  default: 'DEF',
  label: 'x',
  ...over,
});

test('coerce returns the default for a missing value (undefined OR null)', () => {
  for (const missing of [undefined, null]) {
    assert.equal(coerce(def({ type: 'int', default: 7 }), missing), 7);
    assert.equal(coerce(def({ type: 'bool', default: true }), missing), true, `bool <- ${missing}`);
    assert.equal(coerce(def({ type: 'text', default: 'DEF' }), missing), 'DEF', `text <- ${missing}`);
    assert.equal(coerce(def({ type: 'cron', default: '* * * * *' }), missing), '* * * * *');
  }
  // a present-but-empty string is NOT missing: it stringifies for text.
  assert.equal(coerce(def({ type: 'text', default: 'DEF' }), ''), '');
});

test('coerce bool accepts true / "true" / 1 / "1" and nothing else', () => {
  const b = def({ type: 'bool', default: false });
  for (const truthy of [true, 'true', 1, '1']) assert.equal(coerce(b, truthy), true, JSON.stringify(truthy));
  for (const falsy of [false, 'false', 0, '0', 'yes', 'on', 2, '', 'True', 'TRUE'])
    assert.equal(coerce(b, falsy), false, JSON.stringify(falsy));
});

test('coerce int parses, rejects NaN to the default, and clamps to [min, max]', () => {
  const d = def({ type: 'int', default: 50, min: 1, max: 200 });
  assert.equal(coerce(d, '17'), 17);
  assert.equal(coerce(d, 17), 17);
  assert.equal(coerce(d, '17abc'), 17, 'parseInt takes the leading digits');
  assert.equal(coerce(d, 'abc'), 50, 'unparseable -> default');
  assert.equal(coerce(d, ''), 50);
  assert.equal(coerce(d, 0), 1, 'below min -> min');
  assert.equal(coerce(d, 9999), 200, 'above max -> max');
  assert.equal(coerce(d, 1), 1, 'exactly min is kept');
  assert.equal(coerce(d, 200), 200, 'exactly max is kept');
  assert.equal(coerce(d, 2), 2, 'in range is kept as-is');
});

test('coerce int without min/max does not clamp', () => {
  const d = def({ type: 'int', default: 0 });
  assert.equal(coerce(d, -5), -5);
  assert.equal(coerce(d, 1e9), 1e9);
});

test('coerce int treats min/max of 0 as a real bound, not "absent"', () => {
  const d = def({ type: 'int', default: 5, min: 0, max: 0 });
  assert.equal(coerce(d, -1), 0, 'clamped up to min 0');
  assert.equal(coerce(d, 3), 0, 'clamped down to max 0');
});

test('coerce cron and text both stringify the raw value', () => {
  assert.equal(coerce(def({ type: 'cron', default: '* * * * *' }), '0 0 * * *'), '0 0 * * *');
  assert.equal(coerce(def({ type: 'text' }), 42), '42');
  assert.equal(coerce(def({ type: 'text' }), true), 'true');
});

// --- the defs table ------------------------------------------------

test('SETTING_DEFS: every entry is complete, typed and uniquely keyed', () => {
  const keys = new Set<string>();
  for (const d of SETTING_DEFS) {
    assert.ok(d.key, 'has a key');
    assert.ok(d.group, `${d.key} has a group`);
    assert.ok(d.label, `${d.key} has a label`);
    assert.ok(['text', 'bool', 'int', 'cron'].includes(d.type), `${d.key} type is valid (${d.type})`);
    assert.ok(!keys.has(d.key), `${d.key} is unique`);
    keys.add(d.key);
    if (d.type === 'int') {
      assert.equal(typeof d.default, 'number', `${d.key} int default is numeric`);
      if (d.min != null && d.max != null) assert.ok(d.min <= d.max, `${d.key} min <= max`);
    }
    if (d.type === 'bool') assert.equal(typeof d.default, 'boolean', `${d.key} bool default`);
  }
});

test('SETTING_DEFS: scanCron default is a valid 5-field cron', async () => {
  const { isValidCron } = await import('../src/utils/cron.js');
  const cron = SETTING_DEFS.find((d) => d.key === 'scanCron')!;
  assert.equal(isValidCron(String(cron.default)), true);
});

// --- get / getAll / S (defaults + overrides, no DB) ---------------

test('get returns the declared default before anything is stored or overridden', () => {
  for (const d of SETTING_DEFS) {
    const v = get(d.key);
    if (d.type === 'bool') assert.equal(typeof v, 'boolean', d.key);
    else if (d.type === 'int') assert.equal(typeof v, 'number', d.key);
    else assert.equal(typeof v, 'string', d.key);
  }
  assert.equal(get('scanCron'), '0 0,12 * * *');
  assert.equal(get('watchDebounce'), 5);
  assert.equal(get('deleteMissing'), true);
  assert.equal(get('scanEnabled'), false);
  assert.equal(get('watchEnabled'), false);
  assert.equal(get('coverShow'), true);
  assert.equal(get('titleAsFilename'), true);
});

test('get throws for an unknown key', () => {
  assert.throws(() => get('nope' as never), /unknown setting: nope/);
});

test('an override wins over the default and is coerced by type', () => {
  setOverride('maxItems', '999');
  assert.equal(get('maxItems'), 200, 'coerced and clamped');
  setOverride('maxItems', undefined as never);
  assert.equal(typeof get('maxItems'), 'number');
});

test('getAll returns exactly the SETTING_DEFS keys', () => {
  const all = getAll();
  assert.deepEqual(new Set(Object.keys(all)), new Set(SETTING_DEFS.map((d) => d.key)));
});

test('the S proxy is a live view of get()', () => {
  assert.equal(S.scanCron, get('scanCron'));
  assert.equal(S.maxItems, get('maxItems'));
});

test('getState returns null for a key the cache has never seen', () => {
  assert.equal(getState('never-set-abc'), null);
});

test('onChange returns an unsubscribe that removes exactly that listener', () => {
  let calls = 0;
  const off = onChange(() => { calls += 1; });
  assert.equal(typeof off, 'function');
  off();
  off(); // idempotent
  assert.equal(calls, 0);
});

test('SettingsError carries the field map and a 400 status', () => {
  const e = new SettingsError({ scanCron: 'bad' });
  assert.equal(e.status, 400);
  assert.deepEqual(e.fields, { scanCron: 'bad' });
  assert.match(e.message, /invalid settings/);
  assert.ok(e instanceof Error);
});
