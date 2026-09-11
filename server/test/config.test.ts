import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig, parseExtensions } from '../src/config/index.js';
import { findUp } from '../src/config/paths.js';

// buildConfig() reads an environment into the typed Config; every field has a
// default and every override path is exercised here against an explicit env.

test('buildConfig falls back to defaults for an empty environment', () => {
  const c = buildConfig({});
  assert.equal(c.port, 8000);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.db.url, '');
  assert.equal(c.db.host, 'localhost');
  assert.equal(c.db.port, 5432);
  assert.equal(c.db.user, 'sopds');
  assert.equal(c.db.password, 'sopds');
  assert.equal(c.db.database, 'sopds');
  assert.equal(c.zipScan, true);
  assert.equal(c.scanBatchSize, 1000);
  assert.equal(c.scanConcurrency, 0);
  assert.equal(c.maxItems, 50);
  assert.equal(c.doublesHide, true);
  assert.equal(c.siteUrl, '');
  assert.equal(c.title, 'SimpleOPDS Catalog');
  assert.equal(c.subtitle, 'Powered by Node + React');
  assert.equal(c.ebookConvert, 'ebook-convert');
  assert.deepEqual(c.downloadFormats, ['fb2', 'epub', 'mobi']);
  assert.deepEqual(c.bookExtensions, ['.fb2', '.epub', '.mobi', '.pdf', '.djvu']);
  assert.equal(c.rootLib, path.join(c.rootDir, 'books'));
  assert.equal(c.convertCacheDir, path.join(c.rootDir, 'data', 'convert-cache'));
  assert.ok(fs.existsSync(path.join(c.rootDir, 'package.json')), 'rootDir is the server package dir');
});

test('buildConfig takes each scalar override from the environment', () => {
  const c = buildConfig({
    PORT: '9001',
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://u:p@h/db',
    PGHOST: 'pg.example',
    PGPORT: '6000',
    PGUSER: 'alice',
    PGPASSWORD: 'secret',
    PGDATABASE: 'library',
    SOPDS_ROOT_LIB: '/data/books',
    SOPDS_SITE_URL: 'https://opds.example',
    SOPDS_TITLE: 'My Books',
    SOPDS_SUBTITLE: 'shelf',
    SOPDS_SCAN_BATCH_SIZE: '250',
    SOPDS_SCAN_CONCURRENCY: '4',
    SOPDS_MAXITEMS: '20',
    SOPDS_CONVERT_CACHE: '/tmp/cc',
  });
  assert.equal(c.port, 9001);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.db.url, 'postgres://u:p@h/db');
  assert.equal(c.db.host, 'pg.example');
  assert.equal(c.db.port, 6000);
  assert.equal(c.db.user, 'alice');
  assert.equal(c.db.password, 'secret');
  assert.equal(c.db.database, 'library');
  assert.equal(c.rootLib, '/data/books');
  assert.equal(c.siteUrl, 'https://opds.example');
  assert.equal(c.title, 'My Books');
  assert.equal(c.subtitle, 'shelf');
  assert.equal(c.scanBatchSize, 250);
  assert.equal(c.scanConcurrency, 4);
  assert.equal(c.maxItems, 20);
  assert.equal(c.convertCacheDir, '/tmp/cc');
});

test('buildConfig treats a non-numeric or zero numeric env var as "use the default"', () => {
  assert.equal(buildConfig({ PORT: 'abc' }).port, 8000);
  assert.equal(buildConfig({ PGPORT: '' }).db.port, 5432);
  assert.equal(buildConfig({ SOPDS_SCAN_BATCH_SIZE: '0' }).scanBatchSize, 1000, '0 is falsy -> default');
  assert.equal(buildConfig({ SOPDS_MAXITEMS: 'nope' }).maxItems, 50);
  // scanConcurrency defaults to 0, so a bad value must still land on 0.
  assert.equal(buildConfig({ SOPDS_SCAN_CONCURRENCY: 'nope' }).scanConcurrency, 0);
});

test('zipScan and doublesHide are on unless explicitly set to "0"', () => {
  assert.equal(buildConfig({ SOPDS_ZIPSCAN: '0' }).zipScan, false);
  assert.equal(buildConfig({ SOPDS_ZIPSCAN: 'false' }).zipScan, true, 'only "0" disables it');
  assert.equal(buildConfig({ SOPDS_ZIPSCAN: '1' }).zipScan, true);
  assert.equal(buildConfig({ SOPDS_DOUBLES_HIDE: '0' }).doublesHide, false);
  assert.equal(buildConfig({ SOPDS_DOUBLES_HIDE: 'no' }).doublesHide, true, 'only "0" disables it');
});

test('ebookConvert distinguishes "unset" from "set to empty"', () => {
  assert.equal(buildConfig({}).ebookConvert, 'ebook-convert', 'unset -> built-in name');
  assert.equal(buildConfig({ SOPDS_EBOOK_CONVERT: '' }).ebookConvert, '', 'empty string disables the lookup');
  assert.equal(buildConfig({ SOPDS_EBOOK_CONVERT: '/usr/bin/ebook-convert' }).ebookConvert, '/usr/bin/ebook-convert');
});

test('parseExtensions splits on whitespace runs, lower-cases, and keeps no blanks', () => {
  assert.deepEqual(parseExtensions(undefined), ['.fb2', '.epub', '.mobi', '.pdf', '.djvu'], 'default list');
  assert.deepEqual(parseExtensions('.FB2   .EPUB'), ['.fb2', '.epub'], 'runs of spaces, lower-cased');
  assert.deepEqual(parseExtensions('  .cbz  '), ['.cbz'], 'surrounding blanks produce no empty tokens');
  assert.deepEqual(parseExtensions('.a\t.b\n.c'), ['.a', '.b', '.c'], 'tabs and newlines separate too');
  assert.deepEqual(parseExtensions('   '), [], 'all-whitespace -> empty list, not [""]');
  assert.deepEqual(parseExtensions(''), ['.fb2', '.epub', '.mobi', '.pdf', '.djvu'], 'empty string -> default');
  assert.deepEqual(buildConfig({ SOPDS_BOOK_EXTENSIONS: '.ZIP' }).bookExtensions, ['.zip'], 'wired into buildConfig');
});

test('findUp returns the nearest ancestor that contains the marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'findup-'));
  try {
    const deep = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'marker.txt'), '');

    assert.equal(findUp('marker.txt', deep), path.join(root, 'a'), 'walks up to the marker');
    assert.equal(findUp('marker.txt', path.join(root, 'a')), path.join(root, 'a'), 'starts at the marker');
    assert.equal(
      findUp('marker.txt', path.join(root, 'a', 'b')),
      path.join(root, 'a'),
      'one level up',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findUp returns its starting directory when the marker is never found', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'findup-'));
  try {
    const deep = path.join(root, 'x', 'y');
    fs.mkdirSync(deep, { recursive: true });
    // No marker anywhere up to the filesystem root.
    assert.equal(findUp('definitely-not-here-9e3a.txt', deep), deep);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
