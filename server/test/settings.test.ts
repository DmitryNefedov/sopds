import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Run against the in-process PostgreSQL (PGlite) unless told otherwise.
process.env.SOPDS_TEST_DB ??= 'mem';

const { default: db } = await import('../src/db/index.js');
const { initSchema } = await import('../src/db/schema.js');
const settings = await import('../src/services/settings.js');

before(async () => {
  await initSchema();
  await db.exec('TRUNCATE settings');
  await settings.loadSettings();
});

after(async () => {
  await db.end();
});

test('defaults are returned before anything is stored', () => {
  assert.equal(settings.get('maxItems'), settings.SETTING_DEFS.find((d) => d.key === 'maxItems')!.default);
  assert.equal(typeof settings.get('doublesHide'), 'boolean');
});

test('setMany persists and coerces types', async () => {
  await settings.setMany({ maxItems: '17', doublesHide: 'false', title: 'X' });
  assert.equal(settings.get('maxItems'), 17);
  assert.equal(settings.get('doublesHide'), false);
  assert.equal(settings.get('title'), 'X');
});

test('setMany clamps ints to the declared range', async () => {
  await settings.setMany({ maxItems: 9999 });
  assert.equal(settings.get('maxItems'), 200);
});

test('invalid cron is rejected with a field error', async () => {
  await assert.rejects(
    () => settings.setMany({ scanCron: 'not a cron' }),
    (err: unknown) => {
      const e = err as { fields?: Record<string, string> };
      return Boolean(e.fields && e.fields.scanCron);
    },
  );
});

test('unknown keys are rejected with a specific field message', async () => {
  await assert.rejects(
    () => settings.setMany({ nope: 1 } as never),
    (err: unknown) => {
      const e = err as { message: string; fields: Record<string, string> };
      return /invalid settings/.test(e.message) && e.fields.nope === 'unknown setting';
    },
  );
});

test('onChange fires with the patched keys', async () => {
  let seen: Record<string, unknown> = {};
  const off = settings.onChange((patch) => {
    seen = patch as Record<string, unknown>;
  });
  await settings.setMany({ zipScan: false });
  off();
  assert.deepEqual(Object.keys(seen), ['zipScan']);
  await settings.setMany({ title: 'after-unsub' });
  assert.deepEqual(Object.keys(seen), ['zipScan'], 'the unsubscribed listener did not see the "title" patch');
});

test('setMany rejects a non-numeric int with an "expected a number" field error', async () => {
  await assert.rejects(
    () => settings.setMany({ maxItems: 'lots' }),
    (err: unknown) => (err as { fields?: Record<string, string> }).fields?.maxItems === 'expected a number',
  );
});

test('setMany reports every bad key at once and writes nothing', async () => {
  await settings.setMany({ title: 'Before' });
  await assert.rejects(
    () => settings.setMany({ title: 'After', nope: 1, scanCron: 'x' } as never),
    (err: unknown) => {
      const f = (err as { fields: Record<string, string> }).fields;
      return 'nope' in f && 'scanCron' in f && !('title' in f);
    },
  );
  assert.equal(settings.get('title'), 'Before', 'the valid key in a rejected batch is not written');
});

test('a throwing onChange listener does not break setMany', async () => {
  const off = settings.onChange(() => { throw new Error('listener boom'); });
  await settings.setMany({ title: 'Still Works' });
  off();
  assert.equal(settings.get('title'), 'Still Works');
});

test('setState / getState round-trip a JSON value, kept apart from real settings', async () => {
  await settings.setState('lastScan', { at: 123, ok: true });
  assert.deepEqual(settings.getState('lastScan'), { at: 123, ok: true });
  await settings.setState('lastScan', { at: 456, ok: false });
  assert.deepEqual(settings.getState('lastScan'), { at: 456, ok: false }, 'ON CONFLICT updates in place');
  assert.equal(settings.getState('missing'), null);
  // The value is persisted under the "__state." prefix, so it survives a reload.
  await settings.loadSettings();
  assert.deepEqual(settings.getState('lastScan'), { at: 456, ok: false });
});

test('rawValue falls back to the stored string when it is not valid JSON', async () => {
  // Write a non-JSON value straight into the table, then reload the cache.
  await db.run("INSERT INTO settings (key, value) VALUES ('title', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", ['plain-not-json']);
  await settings.loadSettings();
  assert.equal(settings.get('title'), 'plain-not-json');
});

test('loadSettings replaces the cache rather than merging into it', async () => {
  await settings.setMany({ title: 'Cached' });
  assert.equal(settings.get('title'), 'Cached');
  await db.exec('TRUNCATE settings');
  await settings.loadSettings();
  assert.equal(
    settings.get('title'),
    settings.SETTING_DEFS.find((d) => d.key === 'title')!.default,
    'back to the default after the row is gone',
  );
});
