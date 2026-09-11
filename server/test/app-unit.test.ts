import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.SOPDS_TEST_DB ??= 'mem';
// verbose so the requestLogger middleware actually does something we can observe
process.env.SOPDS_LOG_REQUESTS = '1';

const { default: db } = await import('../src/db/index.js');
const { initSchema } = await import('../src/db/schema.js');
const settings = await import('../src/services/settings.js');
const { createApp, serveWebApp, errorHandler, API_PREFIXES, WEB_DIST } = await import('../src/app.js');

// A web-dist directory with a recognisable index.html, so the SPA fallback runs.
const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-web-'));
fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>SPA ROOT</title>');
fs.writeFileSync(path.join(webDist, 'app.js'), 'console.log("asset")');

let server: Server;
let base = '';
const get = (p: string, init?: RequestInit) => fetch(`${base}${p}`, init);

before(async () => {
  await initSchema();
  await settings.loadSettings();
  server = createApp(webDist).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
  fs.rmSync(webDist, { recursive: true, force: true });
});

test('API_PREFIXES / WEB_DIST are the documented values', () => {
  assert.deepEqual(API_PREFIXES, ['/api', '/opds', '/debug']);
  assert.ok(WEB_DIST.endsWith(path.join('web', 'dist')), 'ends with web/dist');
});

test('the app compresses responses and sets permissive CORS headers', async () => {
  // the /debug page is large enough to clear compression's size threshold
  const gz = await get('/debug', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip', 'compression() is mounted');

  const cors = await get('/health', { headers: { origin: 'https://example.test' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), '*', 'cors() is mounted');
});

test('an unhandled route error is caught by the JSON error handler, not Express default', async () => {
  // a non-numeric id makes the catalog query throw, which `ah` forwards to errorHandler
  const res = await get('/api/books/not-a-number');
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = (await res.json()) as { error?: unknown };
  assert.equal(typeof body.error, 'string');
});

test('the verbose request logger is wired into the app', async () => {
  const real = console.log;
  let buf = '';
  console.log = (...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  };
  try {
    await (await get('/health', { headers: { accept: 'text/html' } })).text();
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    console.log = real;
  }
  assert.match(buf, /UI request/, 'requestLogger middleware ran for a navigation');
});

test('GET /health and /healthz report the database is reachable', async () => {
  for (const p of ['/health', '/healthz']) {
    const res = await get(p);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }
});

test('GET /health is a 503 with the error message when the database is unreachable', async () => {
  const real = db.query.bind(db);
  (db as unknown as { query: unknown }).query = async () => {
    throw new Error('connection refused');
  };
  try {
    const res = await get('/health');
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'connection refused' });
  } finally {
    (db as unknown as { query: unknown }).query = real;
  }
});

test('the built web app is served, with an SPA fallback for non-API paths', async () => {
  const root = await get('/');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /SPA ROOT/);

  const asset = await get('/app.js');
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /console\.log/);

  // a deep client route also gets index.html
  const deep = await get('/books/42');
  assert.match(await deep.text(), /SPA ROOT/);
});

test('API prefixes fall through the SPA fallback to a real 404, not index.html', async () => {
  for (const p of ['/api/nope', '/opds/nope', '/debug/nope']) {
    const res = await get(p);
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /SPA ROOT/, `${p} is not swallowed by the SPA fallback`);
  }
});

test('serveWebApp is a no-op when the dist directory is absent', () => {
  const app = express();
  let mounted = 0;
  const origUse = app.use.bind(app);
  (app as unknown as { use: unknown }).use = (...a: unknown[]) => {
    mounted++;
    return (origUse as (...x: unknown[]) => unknown)(...a);
  };
  serveWebApp(app as express.Express, path.join(webDist, 'does-not-exist'));
  assert.equal(mounted, 0, 'nothing is mounted for a missing dist');
});

test('errorHandler turns a thrown error into a 500 JSON body', () => {
  const app = express();
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  app.use(errorHandler);
  const srv = app.listen(0, '127.0.0.1');
  return new Promise<void>((resolve, reject) => {
    srv.once('listening', async () => {
      try {
        const p = (srv.address() as AddressInfo).port;
        const res = await fetch(`http://127.0.0.1:${p}/boom`);
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { error: 'kaboom' });
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        srv.close();
      }
    });
  });
});
