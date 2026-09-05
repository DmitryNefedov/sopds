import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import sax from 'sax';
import { convert, CONVERTIBLE } from '../src/services/convert/index.js';
import { balanceHtml } from '../src/services/convert/ir.js';
import type { Ir } from '../src/services/convert/ir.js';
import { fb2ToIr } from '../src/services/convert/fb2.js';
import { epubToIr } from '../src/services/convert/epub.js';
import { mobiToIr } from '../src/services/convert/mobi.js';

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
    test(`${from} -> ${to} produces a parseable ${to} with text preserved`, async () => {
      const src = fs.readFileSync(samples[from as keyof typeof samples]);
      const srcText = plainText(TO_IR[from](src));

      const out = await convert(src, from, to, `test:${from}`);
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

// An EPUB chapter is parsed as strict XML by every reader: one unmatched tag
// does not spoil a paragraph, it makes the rest of the file invisible. The
// sample above came out of Calibre and has no <title> elements at all, so it
// never exercised the path that broke — a hand-written FB2 does.
const FB2_WITH_TITLES = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>sf</genre>
<author><first-name>Ivan</first-name><last-name>Testov</last-name></author>
<book-title>Title Test</book-title><lang>en</lang></title-info></description>
<body>
<section>
<title><p>Chapter One</p></title>
<p>First paragraph with <emphasis>emphasis</emphasis> in it.</p>
<p>Second paragraph &amp; an ampersand.</p>
<poem><stanza><v>A line of verse</v><v>And another</v></stanza></poem>
</section>
<section>
<title><p>Chapter</p><p>Two</p></title>
<epigraph><p>An epigraph.</p></epigraph>
<p>Chapter two body text.</p>
</section>
</body>
</FictionBook>`;

/** Returns the first XML well-formedness error in `xml`, or null. */
function xmlError(xml: string): string | null {
  const p = sax.parser(true, {});
  let err: string | null = null;
  p.onerror = (e: Error) => {
    if (!err) err = e.message.split('\n')[0];
    (p as unknown as { resume(): void }).resume();
  };
  try {
    p.write(xml).close();
  } catch (e) {
    if (!err) err = String(e).split('\n')[0];
  }
  return err;
}

function epubChapters(epub: Buffer): { name: string; xml: string }[] {
  return new AdmZip(epub)
    .getEntries()
    .filter((e) => e.entryName.endsWith('.xhtml'))
    .map((e) => ({ name: e.entryName, xml: e.getData().toString('utf8') }));
}

test('every epub chapter is well-formed XML', async () => {
  for (const [name, src] of [
    ['sample', fs.readFileSync(samples.fb2)],
    ['titled', Buffer.from(FB2_WITH_TITLES, 'utf8')],
  ] as const) {
    const chapters = epubChapters(await convert(src as Buffer, 'fb2', 'epub'));
    assert.ok(chapters.length > 0, `${name}: produced chapters`);
    for (const c of chapters) {
      assert.equal(xmlError(c.xml), null, `${name}/${c.name} must parse as XML`);
    }
  }
});

test('an fb2 <title> contributes a heading, not stray markup', async () => {
  // Regression: the <p> inside <title> had its opening tag suppressed but its
  // closing tag emitted, so every chapter body started with a stray </p> and
  // readers rendered nothing past it.
  const chapters = epubChapters(await convert(Buffer.from(FB2_WITH_TITLES, 'utf8'), 'fb2', 'epub'));
  const first = chapters.find((c) => c.name.endsWith('chapter-0001.xhtml'))!;
  assert.ok(!/<body>\s*<\/p>/.test(first.xml), 'no stray closing tag at the top of the body');
  assert.match(first.xml, /First paragraph with <em>emphasis<\/em> in it\./);

  // Assert on the IR too, not just the EPUB: balanceHtml would paper over a
  // regression here, and the fb2 reader is expected to emit balanced markup on
  // its own rather than lean on the safety net.
  const ir = fb2ToIr(Buffer.from(FB2_WITH_TITLES, 'utf8'));
  assert.deepEqual(ir.chapters.map((c) => c.title), ['Chapter One', 'Chapter Two']);
  for (const c of ir.chapters) {
    assert.ok(!/^\s*<\//.test(c.html), `"${c.title}" must not start with a closing tag`);
    assert.equal(balanceHtml(c.html), c.html, `"${c.title}" is already balanced`);
  }
});

test('balanceHtml repairs what would otherwise be an unreadable chapter', () => {
  assert.equal(balanceHtml('</p><p>hi</p>'), '<p>hi</p>', 'a closer that never opened is dropped');
  assert.equal(balanceHtml('<p>hi'), '<p>hi</p>', 'an unclosed tag is closed');
  assert.equal(balanceHtml('<p><em>hi</p>'), '<p><em>hi</em></p>', 'closed in the right order');
  assert.equal(balanceHtml('<br>'), '<br/>', 'void elements are self-closed');
  assert.equal(balanceHtml('a & b'), 'a &amp; b', 'a bare ampersand is escaped');
  assert.equal(balanceHtml('a&nbsp;b'), 'a&#160;b', 'named entities become numeric');
  assert.equal(balanceHtml('&amp; &#160; &lt;'), '&amp; &#160; &lt;', 'valid references are kept');
  assert.equal(xmlError(`<x>${balanceHtml('</p><b>a & b<br>')}</x>`), null);
});

test('same-format conversion is a no-op passthrough', async () => {
  const src = fs.readFileSync(samples.fb2);
  assert.equal(await convert(src, 'fb2', 'fb2'), src);
});

test('unsupported source format is rejected', async () => {
  await assert.rejects(() => convert(Buffer.from('x'), 'pdf', 'epub'), /Cannot convert from/);
});

test('fb2 -> epub keeps the title and author', async () => {
  const src = fs.readFileSync(samples.fb2);
  const ir = fb2ToIr(src);
  const epub = await convert(src, 'fb2', 'epub');
  const back = epubToIr(epub);
  assert.equal(back.title, ir.title);
  assert.deepEqual(back.authors, ir.authors);
});
