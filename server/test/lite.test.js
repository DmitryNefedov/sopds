import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-lite-'));
process.env.SOPDS_DB = path.join(tmp, 'test.db');

const db = (await import('../src/db.js')).default;
const { updateCounters } = await import('../src/db.js');
const { default: liteRouter } = await import('../src/routes/lite.js');
const { wantsLiteUi } = await import('../src/eink-detect.js');

let server;
let base;

before(async () => {
  const book = db.prepare(
    `INSERT INTO books (filename, path, format, title, search_title, lang_code, avail)
     VALUES (?, ?, 'fb2', ?, ?, 2, 2)`,
  );
  const author = db.prepare(
    'INSERT INTO authors (full_name, search_full_name, lang_code) VALUES (?, ?, 2)',
  );
  const link = db.prepare(
    'INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)',
  );
  const b = Number(book.run('d.fb2', '.', 'Dune', 'DUNE').lastInsertRowid);
  const a = Number(author.run('Herbert Frank', 'HERBERT FRANK').lastInsertRowid);
  link.run(b, a);
  updateCounters();

  const app = express();
  app.use('/lite', liteRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (p) =>
  new Promise((resolve, reject) => {
    http
      .get(base + p, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });

test('lite home renders without JS', async () => {
  const r = await get('/lite');
  assert.equal(r.status, 200);
  assert.match(r.body, /<title>/);
  assert.doesNotMatch(r.body, /<script/i);
  assert.match(r.body, /Switch to the full site/);
});

test('lite search does the cross-entity match', async () => {
  const r = await get('/lite/search?q=herbert');
  assert.equal(r.status, 200);
  assert.match(r.body, /Herbert Frank/);
  assert.match(r.body, /Dune/); // book found via its author
});

test('lite book page lists all three download formats', async () => {
  const r = await get('/lite/book/1');
  assert.equal(r.status, 200);
  assert.match(r.body, /format=fb2/);
  assert.match(r.body, /format=epub/);
  assert.match(r.body, /format=mobi/);
});

test('lite escapes HTML in titles', async () => {
  db.prepare(
    `INSERT INTO books (filename, path, format, title, search_title, lang_code, avail)
     VALUES ('x.fb2', '.', 'fb2', ?, 'X', 2, 2)`,
  ).run('<script>alert(1)</script>');
  const r = await get('/lite/books');
  assert.doesNotMatch(r.body, /<script>alert/);
  assert.match(r.body, /&lt;script&gt;/);
});

test('wantsLiteUi: Kindle yes, EinkBro/Chrome/Firefox no', () => {
  const req = (ua, headers = {}) => ({
    query: {},
    get: (h) => headers[h.toLowerCase()] ?? (h.toLowerCase() === 'user-agent' ? ua : ''),
  });
  assert.equal(
    wantsLiteUi(req('Mozilla/5.0 (X11; U; Linux armv7l like Android) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+')),
    true,
  );
  assert.equal(
    wantsLiteUi(req('Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0 Safari/537.36')),
    false,
  );
  assert.equal(
    wantsLiteUi(req('Mozilla/5.0 (Android 11; Mobile; rv:109.0) Gecko/117.0 Firefox/117.0')),
    false,
  );
  assert.equal(wantsLiteUi(req('anything', { cookie: 'lite=1' })), true);
  assert.equal(
    wantsLiteUi({ query: { lite: '0' }, get: () => 'Kindle/3.0+' }),
    false,
  );
});
