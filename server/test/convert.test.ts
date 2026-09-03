import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, CONVERTIBLE } from '../src/convert/index.js';
import type { Ir } from '../src/convert/ir.js';
import { fb2ToIr } from '../src/convert/fb2.js';
import { epubToIr } from '../src/convert/epub.js';
import { mobiToIr } from '../src/convert/mobi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'fixtures');

const samples = {
  fb2: path.join(DATA, '262001.fb2'),
  epub: path.join(DATA, 'mirer.epub'),
  mobi: path.join(DATA, 'robin_cook.mobi'),
};

const TO_IR: Record<string, (b: Buffer) => Ir> = { fb2: fb2ToIr, epub: epubToIr, mobi: mobiToIr };

function plainText(ir: Ir): string {
  return ir.chapters
    .map((c) => c.html.replace(/<[^>]+>/g, ' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

for (const from of CONVERTIBLE) {
  for (const to of CONVERTIBLE) {
    if (from === to) continue;
    test(`${from} -> ${to} produces a parseable ${to} with text preserved`, () => {
      const src = fs.readFileSync(samples[from as keyof typeof samples]);
      const srcText = plainText(TO_IR[from](src));

      const out = convert(src, from, to, `test:${from}`);
      assert.ok(out.length > 100, 'output is non-trivial');

      const outIr = TO_IR[to](out);
      const outText = plainText(outIr);

      // A big chunk of the source's words should survive the round trip.
      const srcWords = srcText.split(' ').filter((w: string) => w.length > 4).slice(0, 40);
      const hit = srcWords.filter((w: string) => outText.includes(w)).length;
      assert.ok(
        hit >= srcWords.length * 0.6,
        `expected >=60% of sampled words to survive ${from}->${to}, got ${hit}/${srcWords.length}`,
      );
    });
  }
}

test('same-format conversion is a no-op passthrough', () => {
  const src = fs.readFileSync(samples.fb2);
  assert.equal(convert(src, 'fb2', 'fb2'), src);
});

test('unsupported source format is rejected', () => {
  assert.throws(() => convert(Buffer.from('x'), 'pdf', 'epub'), /Cannot convert from/);
});

test('fb2 -> epub keeps the title and author', () => {
  const src = fs.readFileSync(samples.fb2);
  const ir = fb2ToIr(src);
  const epub = convert(src, 'fb2', 'epub');
  const back = epubToIr(epub);
  assert.equal(back.title, ir.title);
  assert.deepEqual(back.authors, ir.authors);
});
