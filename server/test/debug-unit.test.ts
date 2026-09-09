import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Request } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// The verbose logger only does anything when this is not '0'.
process.env.SOPDS_LOG_REQUESTS = '1';

const { isNavigation, clientIp, requestLogger, debugRouter } = await import('../src/routes/debug.js');

// ---- isNavigation (pure) --------------------------------------------

const fakeReq = (over: {
  path?: string;
  headers?: Record<string, string>;
}): Request => {
  const headers = over.headers ?? {};
  return {
    path: over.path ?? '/',
    headers,
    get: (h: string) => headers[h.toLowerCase()],
  } as unknown as Request;
};

test('isNavigation: API and OPDS paths are never navigations', () => {
  assert.equal(isNavigation(fakeReq({ path: '/api/books' })), false);
  assert.equal(isNavigation(fakeReq({ path: '/opds/search' })), false);
  // even with a document hint
  assert.equal(
    isNavigation(fakeReq({ path: '/api/x', headers: { 'sec-fetch-dest': 'document' } })),
    false,
  );
});

test('isNavigation: an explicit document fetch is a navigation', () => {
  assert.equal(
    isNavigation(fakeReq({ path: '/anything.js', headers: { 'sec-fetch-dest': 'document' } })),
    true,
    'sec-fetch-dest wins even over an asset-looking extension',
  );
});

test('isNavigation: an HTML Accept header is a navigation', () => {
  assert.equal(
    isNavigation(fakeReq({ path: '/x.css', headers: { accept: 'text/html,application/xhtml+xml' } })),
    true,
  );
});

test('isNavigation: an extensionless path is a navigation, an asset path is not', () => {
  assert.equal(isNavigation(fakeReq({ path: '/books/42' })), true);
  assert.equal(isNavigation(fakeReq({ path: '/' })), true);
  assert.equal(isNavigation(fakeReq({ path: '/assets/main.js' })), false);
  assert.equal(isNavigation(fakeReq({ path: '/logo.PNG' })), false, 'the extension test is case-insensitive');
  assert.equal(isNavigation(fakeReq({ path: '/data.json' })), false);
  // the extension test is anchored to the end of the path - a dot mid-path is not an extension
  assert.equal(isNavigation(fakeReq({ path: '/v1.2/dashboard' })), true);
  assert.equal(isNavigation(fakeReq({ path: '/a.b/c.d/page' })), true);
});

// ---- clientIp (pure) ----------------------------------------------

test('clientIp: the first X-Forwarded-For hop wins, trimmed', () => {
  assert.equal(
    clientIp({ headers: { 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' }, socket: {} } as unknown as Request),
    '203.0.113.7',
  );
});

test('clientIp: falls back to the socket peer, then to "?"', () => {
  assert.equal(
    clientIp({ headers: {}, socket: { remoteAddress: '198.51.100.9' } } as unknown as Request),
    '198.51.100.9',
  );
  assert.equal(clientIp({ headers: {}, socket: {} } as unknown as Request), '?');
  // an array-valued header is ignored (not a string) -> socket peer
  assert.equal(
    clientIp({ headers: { 'x-forwarded-for': ['a', 'b'] }, socket: { remoteAddress: 's' } } as unknown as Request),
    's',
  );
});

// ---- requestLogger + debugRouter over HTTP ------------------------

let server: Server;
let base = '';
const req = (p: string, init?: RequestInit) => fetch(`${base}${p}`, init);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(requestLogger);
  app.use('/debug', debugRouter);
  app.get('/page', (_r, res) => res.send('hi'));
  app.get('/api/thing', (_r, res) => res.json({ ok: 1 }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((r) => server.close(r)));

test('requestLogger passes every request through exactly once', async () => {
  // a navigation and a non-navigation both reach their handler untouched
  assert.equal(await (await req('/page', { headers: { accept: 'text/html' } })).text(), 'hi');
  assert.deepEqual(await (await req('/api/thing')).json(), { ok: 1 });
});

// Capture console.log while a request completes; the finish listener may fire a
// tick after the body resolves, so give it a moment.
async function logLinesFor(url: string, init?: RequestInit): Promise<string> {
  const real = console.log;
  let buf = '';
  console.log = (...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  };
  try {
    const res = await req(url, init);
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    console.log = real;
  }
  return buf;
}

test('requestLogger logs a verbose block for a navigation, but not for an API call or an asset', async () => {
  assert.match(await logLinesFor('/page', { headers: { accept: 'text/html' } }), /UI request/);
  assert.doesNotMatch(await logLinesFor('/api/thing'), /UI request/, 'API calls are not logged');
  assert.doesNotMatch(await logLinesFor('/main.js'), /UI request/, 'asset requests are not logged');
});

test('GET /debug/headers echoes the request metadata as JSON', async () => {
  const res = await req('/debug/headers', { headers: { 'x-test': 'yes' } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.match(body.time as string, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal(body.method, 'GET');
  assert.equal(body.url, '/debug/headers');
  assert.equal((body.headers as Record<string, string>)['x-test'], 'yes');
  assert.equal(typeof body.httpVersion, 'string');
  assert.ok('remoteAddress' in body);
});

test('POST /debug/report acknowledges with {ok:true}', async () => {
  const res = await req('/debug/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET /debug serves the device-check HTML page', async () => {
  const res = await req('/debug');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /SimpleOPDS device check/);
});
