import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// SOPDS_ADMIN_TOKEN is read when the admin router is imported, so this guard
// needs its own process — which is what one test file per process gives us.

process.env.SOPDS_TEST_DB ??= 'mem';
process.env.SOPDS_LOG_REQUESTS = '0';
process.env.SOPDS_ADMIN_TOKEN = 's3cret';

const { default: db } = await import('../src/db/index.js');
const { initSchema } = await import('../src/db/schema.js');
const { loadSettings } = await import('../src/services/settings.js');
const { createApp } = await import('../src/app.js');

let server: Server;
let base = '';

before(async () => {
  await initSchema();
  await loadSettings();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

test('an admin request without the token is refused', async () => {
  const res = await fetch(`${base}/api/admin/settings`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'admin token required' });
});

test('a wrong token is refused too', async () => {
  const res = await fetch(`${base}/api/admin/settings`, { headers: { 'x-admin-token': 'nope' } });
  assert.equal(res.status, 401);
});

test('the token is accepted as a header or as ?token=', async () => {
  const viaHeader = await fetch(`${base}/api/admin/settings`, {
    headers: { 'x-admin-token': 's3cret' },
  });
  assert.equal(viaHeader.status, 200);
  assert.equal(((await viaHeader.json()) as { auth: boolean }).auth, true);

  const viaQuery = await fetch(`${base}/api/admin/settings?token=s3cret`);
  assert.equal(viaQuery.status, 200);
});

test('the guard covers writes and the scan trigger, not the public API', async () => {
  const write = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subtitle: 'nope' }),
  });
  assert.equal(write.status, 401);
  assert.equal((await fetch(`${base}/api/admin/scan`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/stats`)).status, 200);
});
