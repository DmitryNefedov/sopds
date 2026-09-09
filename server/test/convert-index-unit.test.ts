import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  convert,
  ConvertError,
  CONVERTIBLE,
  converterInfo,
  refreshConverter,
  onSettingsPatch,
  probeConverter,
  whichSync,
  cacheKeyFor,
  runExternal,
  externalConvert,
  type ExecFileAsync,
} from '../src/services/convert/index.js';
import { setOverride } from '../src/services/settings.js';

const MINIMAL_FB2 = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
<description><title-info><book-title>T</book-title>
<author><first-name>A</first-name><last-name>B</last-name></author></title-info></description>
<body><section><title><p>One</p></title><p>Hello there world.</p></section></body>
</FictionBook>`,
  'utf8',
);

// ---- probeConverter ------------------------------------------------

test('probeConverter: an empty or missing candidate resolves to null without probing', () => {
  // inject deps that WOULD resolve, to prove the empty candidate short-circuits
  const deps = { existsSync: () => true, lookup: () => '/somewhere/ebook-convert' };
  assert.equal(probeConverter('', deps), null);
  assert.equal(probeConverter(null, deps), null);
  assert.equal(probeConverter(undefined, deps), null);
});

test('probeConverter: a slash path is used verbatim iff it exists', () => {
  const seen: string[] = [];
  const existsSync = (p: string) => {
    seen.push(p);
    return p === '/opt/calibre/ebook-convert';
  };
  assert.equal(probeConverter('/opt/calibre/ebook-convert', { existsSync }), '/opt/calibre/ebook-convert');
  assert.equal(probeConverter('/nope/ebook-convert', { existsSync }), null);
  assert.deepEqual(seen, ['/opt/calibre/ebook-convert', '/nope/ebook-convert'], 'existsSync was consulted, not lookup');
});

test('probeConverter: a bare name is looked up on PATH, taking the first line, trimmed', () => {
  assert.equal(
    probeConverter('ebook-convert', { lookup: () => '/usr/bin/ebook-convert\n/other/one\n' }),
    '/usr/bin/ebook-convert',
  );
  // a leading blank line is trimmed away before the first line is taken
  assert.equal(
    probeConverter('ebook-convert', { lookup: () => '\n/usr/local/bin/ebook-convert\n' }),
    '/usr/local/bin/ebook-convert',
  );
  assert.equal(probeConverter('ebook-convert', { lookup: () => '' }), null, 'no output -> null');
  assert.equal(probeConverter('ebook-convert', { lookup: () => '   \n' }), null, 'blank output -> null');
});

test('probeConverter: a throwing lookup (not found) resolves to null', () => {
  assert.equal(
    probeConverter('ebook-convert', {
      lookup: () => {
        throw new Error('which: no ebook-convert');
      },
    }),
    null,
  );
});

test('whichSync locates a real binary on PATH and throws for a missing one', () => {
  const found = whichSync('sh').trim();
  assert.ok(found.length > 0 && found.endsWith('sh'), `unexpected which output: ${found}`);
  assert.throws(() => whichSync('sopds-no-such-binary-xyzzy'));
});

test('probeConverter: a slash candidate never calls lookup', () => {
  assert.equal(
    probeConverter('/x/y', {
      existsSync: () => false,
      lookup: () => {
        throw new Error('lookup must not run for a path candidate');
      },
    }),
    null,
  );
});

// ---- converterInfo / refreshConverter / onSettingsPatch -----------

test('converterInfo reflects the probed external converter and is memoised', () => {
  setOverride('ebookConvert', '/bin/sh'); // a real slash path that exists
  refreshConverter();
  const info = converterInfo();
  assert.deepEqual(info.formats, CONVERTIBLE);
  assert.equal(info.external, '/bin/sh');
  assert.equal(info.engine, 'calibre');

  // change the setting but do NOT refresh: the old probe result stands
  setOverride('ebookConvert', '');
  assert.equal(converterInfo().engine, 'calibre', 'result is cached until refreshed');

  refreshConverter();
  const off = converterInfo();
  assert.equal(off.external, null);
  assert.equal(off.engine, 'builtin');

  setOverride('ebookConvert', undefined as never);
  refreshConverter();
});

test('onSettingsPatch busts the cache only when ebookConvert is in the patch', () => {
  setOverride('ebookConvert', '/bin/sh');
  refreshConverter();
  assert.equal(converterInfo().engine, 'calibre');

  setOverride('ebookConvert', '');
  onSettingsPatch({ scanCron: '0 0 * * *' } as never); // unrelated key -> no bust
  assert.equal(converterInfo().engine, 'calibre', 'unrelated patch leaves the cache alone');

  onSettingsPatch({ ebookConvert: '' }); // the real key -> bust
  assert.equal(converterInfo().engine, 'builtin');

  setOverride('ebookConvert', undefined as never);
  refreshConverter();
});

// ---- cacheKeyFor -------------------------------------------------

test('cacheKeyFor: no cacheKey -> null, otherwise a stable sha1 hex', () => {
  assert.equal(cacheKeyFor(undefined, 'fb2', 'epub', 10), null);
  const a = cacheKeyFor('book:1', 'fb2', 'epub', 10);
  assert.match(a as string, /^[0-9a-f]{40}$/);
  assert.equal(cacheKeyFor('book:1', 'fb2', 'epub', 10), a, 'deterministic');
});

test('cacheKeyFor: every component participates in the hash', () => {
  const base = cacheKeyFor('k', 'fb2', 'epub', 10);
  assert.notEqual(cacheKeyFor('k2', 'fb2', 'epub', 10), base, 'key');
  assert.notEqual(cacheKeyFor('k', 'mobi', 'epub', 10), base, 'from');
  assert.notEqual(cacheKeyFor('k', 'fb2', 'mobi', 10), base, 'to');
  assert.notEqual(cacheKeyFor('k', 'fb2', 'epub', 11), base, 'length');
});

// ---- runExternal ----------------------------------------------

test('runExternal: writes the input, runs the converter, returns the output, cleans up', async () => {
  let tmpDir = '';
  const exec: ExecFileAsync = async (bin, args, opts) => {
    assert.equal(bin, '/fake/ebook-convert');
    const [inFile, outFile] = args;
    tmpDir = path.dirname(inFile);
    assert.equal(path.basename(inFile), 'in.fb2');
    assert.equal(path.basename(outFile), 'out.epub');
    assert.equal(fs.readFileSync(inFile, 'utf8'), 'SRC-BYTES');
    assert.equal(opts.timeout, 120000);
    assert.equal(opts.maxBuffer, 4 << 20);
    fs.writeFileSync(outFile, 'OUT-BYTES');
    return {};
  };
  const out = await runExternal('/fake/ebook-convert', Buffer.from('SRC-BYTES'), 'fb2', 'epub', exec);
  assert.equal(out.toString(), 'OUT-BYTES');
  assert.ok(tmpDir.startsWith(path.join(os.tmpdir(), 'sopds-conv-')));
  assert.equal(fs.existsSync(tmpDir), false, 'the scratch directory is removed');
});

test('runExternal: a converter failure becomes an "ebook-convert failed" error, stderr preferred and clipped', async () => {
  const longErr = 'E'.repeat(900);
  await assert.rejects(
    () =>
      runExternal('/b', Buffer.from('x'), 'fb2', 'epub', async () => {
        throw { stderr: longErr, message: 'ignored when stderr present' };
      }),
    (e: Error) => {
      assert.match(e.message, /^ebook-convert failed: E+$/);
      assert.equal(e.message.length, 'ebook-convert failed: '.length + 500);
      return true;
    },
  );
});

test('runExternal: falls back to the error message, then to empty, when there is no stderr', async () => {
  await assert.rejects(
    () => runExternal('/b', Buffer.from('x'), 'fb2', 'epub', async () => { throw new Error('boom'); }),
    /ebook-convert failed: boom/,
  );
  await assert.rejects(
    () => runExternal('/b', Buffer.from('x'), 'fb2', 'epub', async () => { throw {}; }),
    (e: Error) => e.message === 'ebook-convert failed: ',
  );
});

test('runExternal: a converter that produces no output file throws (and still cleans up)', async () => {
  await assert.rejects(
    () => runExternal('/b', Buffer.from('x'), 'fb2', 'epub', async () => ({})),
    (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
  );
});

// ---- convert() orchestration --------------------------------------

test('convert: identical from/to is a passthrough', async () => {
  const buf = Buffer.from('whatever');
  assert.equal(await convert(buf, 'fb2', 'fb2'), buf);
});

test('convert: unknown target -> 400, unknown source -> 415', async () => {
  await assert.rejects(() => convert(Buffer.from('x'), 'fb2', 'pdf'), (e: ConvertError) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /Cannot convert to \.pdf/);
    return true;
  });
  await assert.rejects(() => convert(Buffer.from('x'), 'doc', 'epub'), (e: ConvertError) => {
    assert.equal(e.status, 415);
    assert.match(e.message, /only fb2\/epub\/mobi/);
    return true;
  });
});

test('convert: an empty/absent format falls through to the literal "." in the message', async () => {
  const buf = Buffer.from('x');
  await assert.rejects(() => convert(buf, 'fb2', ''), (e: ConvertError) => {
    assert.equal(e.message, 'Cannot convert to .', 'the empty `to` is used verbatim, no default text');
    return true;
  });
  await assert.rejects(() => convert(buf, '', 'epub'), (e: ConvertError) => {
    assert.equal(e.message, 'Cannot convert from . (only fb2/epub/mobi are supported)');
    return true;
  });
});

test('externalConvert: null when no converter is configured, throws when the configured one fails', async () => {
  setOverride('ebookConvert', '');
  refreshConverter();
  assert.equal(await externalConvert(MINIMAL_FB2, 'fb2', 'epub'), null, 'no binary -> null, not a throw');

  setOverride('ebookConvert', '/usr/bin/true'); // exists, exits 0, writes nothing
  refreshConverter();
  await assert.rejects(
    () => externalConvert(MINIMAL_FB2, 'fb2', 'epub'),
    /ebook-convert failed|ENOENT/,
    'a configured binary that produces no output surfaces as a rejection',
  );

  setOverride('ebookConvert', undefined as never);
  refreshConverter();
});

test('convert: a non-fb2 source converts back to fb2 (irToFb2Buf path)', async () => {
  const builtinOnly = { external: async () => null } as const;
  const epub = await convert(MINIMAL_FB2, 'fb2', 'epub', undefined, builtinOnly);
  const fb2 = await convert(epub, 'epub', 'fb2', undefined, builtinOnly);
  assert.match(fb2.toString('utf8'), /<FictionBook/, 'a real FB2 document came back');
});

test('convert: with no deps, the built-in path runs (external converter disabled)', async () => {
  setOverride('ebookConvert', ''); // probe -> null -> externalConvert returns null
  refreshConverter();
  try {
    const out = await convert(MINIMAL_FB2, 'fb2', 'epub');
    assert.equal(out.subarray(0, 2).toString(), 'PK', 'a built-in EPUB came back with no external converter');
  } finally {
    setOverride('ebookConvert', undefined as never);
    refreshConverter();
  }
});

test('convert: with no deps and a real (useless) external binary, runExternal runs then the build-in takes over', async () => {
  // `true` exists on PATH, exits 0, and writes no output file -> ENOENT -> fallback
  setOverride('ebookConvert', '/usr/bin/true');
  refreshConverter();
  try {
    const out = await convert(MINIMAL_FB2, 'fb2', 'epub');
    assert.equal(out.subarray(0, 2).toString(), 'PK');
  } finally {
    setOverride('ebookConvert', undefined as never);
    refreshConverter();
  }
});

test('convert: from/to are lower-cased, and a nullish format coerces to ""', async () => {
  const buf = Buffer.from('x');
  assert.equal(await convert(buf, 'FB2', 'fb2'), buf, 'FB2 and fb2 are the same format -> passthrough');
  // a non-string `to` becomes "", which is not convertible -> 400
  await assert.rejects(() => convert(buf, 'fb2', undefined as never), (e: ConvertError) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /Cannot convert to \./);
    return true;
  });
});

test('convert: the external converter output is used verbatim when it succeeds', async () => {
  const external = async (_b: Buffer, from: string, to: string) => Buffer.from(`EXT:${from}->${to}`);
  const out = await convert(MINIMAL_FB2, 'fb2', 'epub', undefined, { external });
  assert.equal(out.toString(), 'EXT:fb2->epub');
});

test('convert: falls back to the built-in converter when the external one returns null or throws', async () => {
  const viaNull = await convert(MINIMAL_FB2, 'fb2', 'epub', undefined, { external: async () => null });
  assert.ok(viaNull.length > 100 && viaNull.subarray(0, 2).toString() === 'PK', 'a real EPUB (zip) came back');

  const viaThrow = await convert(MINIMAL_FB2, 'fb2', 'epub', undefined, {
    external: async () => {
      throw new Error('calibre exploded');
    },
  });
  assert.equal(viaThrow.subarray(0, 2).toString(), 'PK');
});

test('convert: a built-in conversion failure surfaces as a 422 ConvertError', async () => {
  // a MOBI too small to hold a PalmDB header makes mobiToIr throw
  await assert.rejects(
    () => convert(Buffer.alloc(5), 'mobi', 'epub', undefined, { external: async () => null }),
    (e: ConvertError) => {
      assert.equal(e.status, 422);
      assert.match(e.message, /Conversion mobi->epub failed:/);
      return true;
    },
  );
});

test('convert: with a cacheKey, the result is written then served from the cache dir', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-cache-'));
  // a nested path that does not exist yet, so mkdir recursive actually matters
  const cacheDir = path.join(root, 'a', 'b', 'convert-cache');
  try {
    let calls = 0;
    const external = async () => {
      calls++;
      return Buffer.from('CACHED-OUTPUT');
    };
    const first = await convert(MINIMAL_FB2, 'fb2', 'epub', 'book:7', { external, cacheDir });
    assert.equal(first.toString(), 'CACHED-OUTPUT');
    assert.equal(calls, 1);

    const files = fs.readdirSync(cacheDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{40}\.epub$/);

    // second call: served from disk, the converter is not invoked again
    const second = await convert(MINIMAL_FB2, 'fb2', 'epub', 'book:7', { external, cacheDir });
    assert.equal(second.toString(), 'CACHED-OUTPUT');
    assert.equal(calls, 1, 'the cached file short-circuits the conversion');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('convert: without a cacheKey nothing touches the cache directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-nocache-'));
  const cacheDir = path.join(root, 'should-stay-absent');
  try {
    let calls = 0;
    const external = async () => {
      calls++;
      return Buffer.from('OUT');
    };
    await convert(MINIMAL_FB2, 'fb2', 'epub', undefined, { external, cacheDir });
    await convert(MINIMAL_FB2, 'fb2', 'epub', undefined, { external, cacheDir });
    assert.equal(calls, 2, 'no caching -> the converter runs every time');
    assert.equal(fs.existsSync(cacheDir), false, 'the cache dir was never created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('convert: a broken cache dir is best-effort - conversion still returns', async () => {
  // point the cache at a path whose parent is a file, so mkdirSync throws
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conv-')), 'f');
  fs.writeFileSync(file, '');
  try {
    const out = await convert(MINIMAL_FB2, 'fb2', 'epub', 'book:9', {
      external: async () => Buffer.from('STILL-RETURNED'),
      cacheDir: path.join(file, 'cache'),
    });
    assert.equal(out.toString(), 'STILL-RETURNED');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('ConvertError defaults to status 500', () => {
  assert.equal(new ConvertError('x').status, 500);
  assert.equal(new ConvertError('x', 418).status, 418);
});
