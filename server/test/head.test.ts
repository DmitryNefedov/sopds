import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// The scan reads only a book's metadata header. These cover the two things
// that buys us and the two things it must not break: full metadata still
// lands, the cover is still available on demand, a book whose header is bigger
// than one inflate chunk still parses, and the walk never touches the body.

process.env.SOPDS_TEST_DB ??= 'mem';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-head-'));
const lib = path.join(tmp, 'books');
fs.mkdirSync(lib, { recursive: true });
process.env.SOPDS_ROOT_LIB = lib;

const { default: db } = await import('../src/db/index.js');
const { initSchema } = await import('../src/db/schema.js');
const settings = await import('../src/services/settings.js');
const { runOnce } = await import('../src/services/scanner/engine.js');
const { readBookBytes, readBookCover } = await import('../src/connectors/bookfiles.js');
const { fb2Head } = await import('../src/formats/fb2.js');

// A 1x1 jpeg, embedded as the <binary> cover.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(200, 0x41),
  Buffer.from([0xff, 0xd9]),
]);

/** An FB2 whose <description> is `padKb` KB long and whose body is `bodyKb` KB. */
const FB2 = (title: string, { padKb = 0, bodyKb = 400 } = {}): Buffer =>
  Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info>
<genre>sf_fantasy</genre><genre>prose_history</genre>
<author><first-name>Иван</first-name><last-name>Петров</last-name></author>
<author><first-name>Anna</first-name><last-name>Smith</last-name></author>
<book-title>${title}</book-title>
<annotation><p>Аннотация. ${'долгий текст '.repeat(padKb * 73)}</p></annotation>
<lang>ru</lang>
<sequence name="Хроники" number="7"/>
<coverpage><image l:href="#cover.jpg"/></coverpage>
</title-info>
<document-info><date value="2011-05-03">2011</date></document-info>
</description>
<body>${'<p>тело книги</p>'.repeat(bodyKb * 43)}</body>
<binary id="cover.jpg" content-type="image/jpeg">${JPEG.toString('base64')}</binary>
</FictionBook>`, 'utf8');

const book = (title: string) =>
  db.get<{ id: number; filesize: number; title: string; lang: string; doc_date: string; annotation: string; path: string; filename: string; cat_type: number }>(
    'SELECT * FROM books WHERE title = ?',
    [title],
  );

before(async () => {
  await initSchema();
  await db.exec(
    'TRUNCATE books, authors, series, genres, catalogs, counters RESTART IDENTITY CASCADE',
  );
  await settings.loadSettings();
  await settings.setMany({ scanBatchSize: 1000, zipScan: true, deleteMissing: true });

  fs.writeFileSync(path.join(lib, 'loose.fb2'), FB2('Loose Book'));
  const zip = new AdmZip();
  zip.addFile('zipped.fb2', FB2('Zipped Book'));
  // A header that will not fit in the inflater's first 16 KB chunk.
  zip.addFile('bigheader.fb2', FB2('Big Header', { padKb: 40 }));
  zip.writeZip(path.join(lib, 'pack.zip'));
});

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.end();
});

test('fb2Head clips at </description> and leaves a headerless file alone', () => {
  const full = FB2('X');
  const head = fb2Head(full);
  assert.ok(head.length < full.length / 10, 'header should be a small fraction of the file');
  assert.ok(head.toString('utf8').endsWith('</description>'));
  assert.ok(!head.includes(Buffer.from('<binary')), 'cover must not be in the header');

  const noDesc = Buffer.from('<FictionBook><body>x</body></FictionBook>');
  assert.equal(fb2Head(noDesc).length, noDesc.length);
});

test('a header-only scan still records the full metadata', async () => {
  const stats = await runOnce({ log: () => {} });
  assert.equal(stats.added, 3);
  assert.equal(stats.bad, 0);

  for (const title of ['Loose Book', 'Zipped Book', 'Big Header']) {
    const b = (await book(title))!;
    assert.ok(b, `${title} was catalogued`);
    assert.equal(b.lang, 'ru');
    assert.equal(b.doc_date, '2011-05-03');
    assert.match(b.annotation, /^Аннотация\./);

    const authors = await db.all<{ full_name: string }>(
      `SELECT a.full_name FROM authors a JOIN book_authors ba ON ba.author_id = a.id
       WHERE ba.book_id = ? ORDER BY a.full_name`,
      [b.id],
    );
    assert.deepEqual(authors.map((a) => a.full_name).sort(), ['Smith Anna', 'Петров Иван']);

    const genres = await db.all<{ genre: string }>(
      `SELECT g.genre FROM genres g JOIN book_genres bg ON bg.genre_id = g.id
       WHERE bg.book_id = ? ORDER BY g.genre`,
      [b.id],
    );
    assert.deepEqual(genres.map((g) => g.genre), ['prose_history', 'sf_fantasy']);

    const ser = await db.get<{ ser: string; ser_no: number }>(
      `SELECT s.ser, bs.ser_no FROM series s JOIN book_series bs ON bs.ser_id = s.id
       WHERE bs.book_id = ?`,
      [b.id],
    );
    assert.equal(ser!.ser, 'Хроники');
    assert.equal(ser!.ser_no, 7);
  }
});

test('filesize is the whole file, not the header that was read', async () => {
  const loose = (await book('Loose Book'))!;
  assert.equal(loose.filesize, fs.statSync(path.join(lib, 'loose.fb2')).size);

  // Zip entries take their size from the central directory.
  const zipped = (await book('Zipped Book'))!;
  assert.equal(zipped.filesize, FB2('Zipped Book').length);
});

test('the cover the scan skipped is still there on demand', async () => {
  for (const title of ['Loose Book', 'Zipped Book']) {
    const b = (await book(title))!;
    const cover = await readBookCover(b as never);
    assert.ok(cover, `${title} has a cover`);
    assert.equal(cover!.mime, 'image/jpeg');
    assert.deepEqual(cover!.data, JPEG);
  }
});

test('the body is still readable in full', async () => {
  const b = (await book('Zipped Book'))!;
  const bytes = await readBookBytes(b as never);
  assert.deepEqual(bytes, FB2('Zipped Book'));
});

test('an archive that fails part-way keeps the books it had already matched', async () => {
  const packPath = path.join(lib, 'pack.zip');
  const original = fs.readFileSync(packPath);

  // Rewrite the archive (a new size is what makes the scan re-read it) and
  // then clobber the *second* central-directory header. yauzl reads the
  // directory lazily, so it hands us `zipped.fb2` and then throws — the shape
  // of a real half-corrupt archive.
  const rebuilt = new AdmZip();
  rebuilt.addFile('zipped.fb2', FB2('Zipped Book'));
  rebuilt.addFile('bigheader.fb2', FB2('Big Header', { padKb: 40 }));
  rebuilt.addFile('extra.fb2', FB2('Extra Book'));
  const damaged = rebuilt.toBuffer();
  const SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  // Find the directory through the end-of-central-directory record rather than
  // by scanning, so we cannot trip over the same bytes inside compressed data.
  const eocd = damaged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'end-of-central-directory record found');
  const first = damaged.readUInt32LE(eocd + 16);
  assert.deepEqual(damaged.subarray(first, first + 4), SIG, 'directory starts where EOCD says');
  const second = damaged.indexOf(SIG, first + 4);
  assert.ok(second > first, 'a second directory header follows');
  damaged[second + 2] = 0xff;
  fs.writeFileSync(packPath, damaged);

  // The writer decides the directory order, so read back which entry the scan
  // will get to before the corrupt header stops it.
  const nameLen = damaged.readUInt16LE(first + 28);
  const reached = damaged.subarray(first + 46, first + 46 + nameLen).toString();
  const titleOf: Record<string, string> = {
    'zipped.fb2': 'Zipped Book',
    'bigheader.fb2': 'Big Header',
    'extra.fb2': 'Extra Book',
  };
  const survives = titleOf[reached];
  const swept = Object.values(titleOf).filter((t) => t !== survives);
  assert.ok(survives, `recognised the first entry (${reached})`);

  const stats = await runOnce({ log: () => {} });
  assert.ok(stats.bad > 0, 'the damage was noticed');
  assert.ok(await book('Loose Book'), 'the loose book is untouched');
  assert.ok(await book(survives), `${survives}, which we did read, stays catalogued`);
  // The entries we never reached are swept — but the archive keeps cat_size = 0,
  // so the next run reads it again and puts them back.
  for (const t of swept) assert.equal(await book(t), undefined, `${t} was swept`);
  const cat = await db.get<{ cat_size: number }>(
    "SELECT cat_size FROM catalogs WHERE path = 'pack.zip'",
  );
  assert.equal(Number(cat!.cat_size), 0, 'the archive is not marked fully scanned');

  fs.writeFileSync(packPath, original);
  const healed = await runOnce({ log: () => {} });
  assert.equal(healed.bad, 0);
  assert.ok(await book('Zipped Book'), 'the next scan restores what it lost');
  assert.ok(await book('Big Header'), 'the next scan restores what it lost');
  assert.equal(await book('Extra Book'), undefined, 'the rebuilt archive is gone again');
});
