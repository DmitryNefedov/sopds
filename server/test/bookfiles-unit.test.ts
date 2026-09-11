import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

process.env.SOPDS_TEST_DB ??= 'mem';

const { readBookBytes, readBookCover, findNocover, nocover } = await import('../src/connectors/bookfiles.js');
const { setOverride } = await import('../src/services/settings.js');
const { zipLocations } = await import('../src/connectors/zip.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-bf-'));
const lib = path.join(tmp, 'lib');

const FB2 = Buffer.from(
  '<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>' +
    '<book-title>Located</book-title></title-info></description>' +
    '<binary id="c" content-type="image/png">' +
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60)]).toString('base64') +
    '</binary></FictionBook>',
  'latin1',
);

before(() => {
  fs.mkdirSync(path.join(lib, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'sub', 'loose.fb2'), FB2);
  const zip = new AdmZip();
  zip.addFile('inside.fb2', FB2);
  zip.writeZip(path.join(lib, 'pack.zip'));
  setOverride('rootLib', lib);
});

after(() => {
  setOverride('rootLib', undefined as never);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readBookBytes reads a loose file by path + filename', async () => {
  const bytes = await readBookBytes({ path: 'sub', filename: 'loose.fb2', cat_type: 0 });
  assert.ok(bytes.equals(FB2));
});

test('readBookBytes reads a zip entry by name when no location is recorded', async () => {
  const bytes = await readBookBytes({ path: 'pack.zip', filename: 'inside.fb2', cat_type: 2 });
  assert.ok(bytes.equals(FB2));
});

test('readBookBytes seeks to a recorded zip location', async () => {
  const loc = (await zipLocations(path.join(lib, 'pack.zip'))).get('inside.fb2')!;
  const bytes = await readBookBytes({
    path: 'pack.zip',
    filename: 'inside.fb2',
    cat_type: 2,
    zip_offset: loc.offset,
    zip_csize: loc.csize,
    zip_method: loc.method,
  });
  assert.ok(bytes.equals(FB2));
});

test('readBookBytes falls back to a name lookup when the recorded location is stale', async () => {
  const bytes = await readBookBytes({
    path: 'pack.zip',
    filename: 'inside.fb2',
    cat_type: 2,
    zip_offset: 999999, // no longer a valid local header
    zip_csize: 10,
    zip_method: 8,
  });
  assert.ok(bytes.equals(FB2), 'the by-name path recovered it');
});

test('readBookBytes needs all three zip_* columns to take the fast path', async () => {
  // Missing zip_method: must still work via the by-name lookup.
  const bytes = await readBookBytes({
    path: 'pack.zip',
    filename: 'inside.fb2',
    cat_type: 2,
    zip_offset: 0,
    zip_csize: 10,
  });
  assert.ok(bytes.equals(FB2));
});

test('readBookBytes rejects a missing loose file', async () => {
  await assert.rejects(() => readBookBytes({ path: 'sub', filename: 'gone.fb2', cat_type: 0 }));
});

test('readBookCover returns the embedded cover, or null when the file is unreadable', async () => {
  const c = await readBookCover({ path: 'sub', filename: 'loose.fb2', cat_type: 0 });
  assert.ok(c && c.mime === 'image/png');
  assert.equal(await readBookCover({ path: 'sub', filename: 'missing.fb2', cat_type: 0 }), null);
});

// --- findNocover ---------------------------------------------------

test('findNocover prefers png, then svg, then jpg, then null', () => {
  const d = path.join(tmp, 'assets');
  fs.mkdirSync(d, { recursive: true });
  assert.equal(findNocover(d), null, 'nothing present');

  fs.writeFileSync(path.join(d, 'nocover.jpg'), 'JPG');
  assert.deepEqual(findNocover(d), { data: Buffer.from('JPG'), type: 'image/jpeg' });

  fs.writeFileSync(path.join(d, 'nocover.svg'), 'SVG');
  assert.deepEqual(findNocover(d), { data: Buffer.from('SVG'), type: 'image/svg+xml' }, 'svg beats jpg');

  fs.writeFileSync(path.join(d, 'nocover.png'), 'PNG');
  assert.deepEqual(findNocover(d), { data: Buffer.from('PNG'), type: 'image/png' }, 'png beats all');
});

test('nocover reads the real assets/ placeholder and caches it', () => {
  const a = nocover();
  assert.ok(a && a.data.length > 0 && /^image\//.test(a.type));
  assert.equal(nocover(), a, 'the second call returns the same cached object');
});
