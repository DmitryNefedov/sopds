import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Run against the in-process PostgreSQL (PGlite) unless told otherwise.
process.env.SOPDS_TEST_DB ??= 'mem';

const { default: db, initSchema } = await import('../src/db.js');
const settings = await import('../src/settings.js');

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

test('unknown keys are rejected', async () => {
  await assert.rejects(() => settings.setMany({ nope: 1 } as never), /invalid settings/);
});

test('onChange fires with the patched keys', async () => {
  let seen: Record<string, unknown> = {};
  const off = settings.onChange((patch) => {
    seen = patch as Record<string, unknown>;
  });
  await settings.setMany({ zipScan: false });
  off();
  assert.deepEqual(Object.keys(seen), ['zipScan']);
});
