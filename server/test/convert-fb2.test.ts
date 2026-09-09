import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fb2ToIr, irToFb2, htmlFragmentToFb2, extForMime } from '../src/services/convert/fb2.js';
import { emptyIr } from '../src/services/convert/ir.js';
import type { Ir } from '../src/services/convert/ir.js';

// The FB2 <-> IR converter. fb2ToIr is a SAX walk; irToFb2 + htmlFragmentToFb2
// are string templating. Both are covered here through their public surface.

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const fb2 = (opts: {
  desc?: string;
  body?: string;
  binaries?: string;
}) => `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info>${opts.desc ?? '<book-title>T</book-title><lang>en</lang>'}</title-info></description>
${opts.body ? `<body>${opts.body}</body>` : ''}
${opts.binaries ?? ''}
</FictionBook>`;

const buf = (s: string) => Buffer.from(s, 'utf8');
const irOf = (opts: Parameters<typeof fb2>[0]) => fb2ToIr(buf(fb2(opts)));
const chapterHtml = (opts: Parameters<typeof fb2>[0]) => irOf(opts).chapters.map((c) => c.html).join('\n');

// ---- fb2ToIr: description ------------------------------------------

test('fb2ToIr reads the title, language and every title-info author', () => {
  const ir = irOf({
    desc: `<book-title>War and Peace</book-title><lang>ru</lang>
      <author><first-name>Leo</first-name><last-name>Tolstoy</last-name></author>
      <author><nickname>Anon</nickname></author>`,
  });
  assert.equal(ir.title, 'War and Peace');
  assert.equal(ir.language, 'ru');
  assert.deepEqual(ir.authors, ['Leo Tolstoy', 'Anon'], 'first+last joined, else the nickname');
});

test('fb2ToIr assembles an author name from whichever name parts are present', () => {
  const one = (parts: string) =>
    irOf({ desc: `<book-title>T</book-title><author>${parts}</author>` }).authors;
  assert.deepEqual(one('<first-name>Solo</first-name>'), ['Solo']);
  assert.deepEqual(one('<last-name>Solo</last-name>'), ['Solo']);
  assert.deepEqual(one('<nickname>Solo</nickname>'), ['Solo'], 'the nickname is the fallback');
  assert.deepEqual(
    one('<first-name>A</first-name><last-name>B</last-name><nickname>N</nickname>'),
    ['A B'],
    'first + last win over the nickname',
  );
});

test('fb2ToIr resolves the coverpage href to the exact binary it points at', () => {
  const png = PNG_1x1;
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)]);
  const ir = irOf({
    desc: '<book-title>T</book-title><coverpage><image l:href="#two"/></coverpage>',
    binaries:
      `<binary id="one" content-type="image/png">${png.toString('base64')}</binary>` +
      `<binary id="two" content-type="image/gif">${gif.toString('base64')}</binary>`,
  });
  assert.equal(ir.cover!.mime, 'image/gif', 'the cover is the #two binary, not just images[0]');
  assert.ok(ir.cover!.data.equals(gif));
});

test('fb2ToIr accepts xlink:href as well as l:href for a body image', () => {
  assert.equal(
    chapterHtml({ body: `<section><p>x</p><image xlink:href="#z"/></section>` }),
    '<p>x</p><img src="images/z" alt=""/>',
  );
});

test('fb2ToIr recovers content from a malformed FB2 rather than losing everything after the error', () => {
  // An unclosed <emphasis>: a strict parser throws and drops the rest of the
  // body; the lenient parser keeps going.
  const ir = fb2ToIr(
    buf(`<?xml version="1.0"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><book-title>T</book-title></title-info></description>
<body><section><p>before <emphasis>oops</p><p>after the mistake</p></section></body>
</FictionBook>`),
  );
  assert.match(ir.chapters[0].html, /after the mistake/, 'text past the malformed tag survives');
});

test('fb2ToIr ignores an author that is not inside title-info', () => {
  const src = `<?xml version="1.0"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
<description>
  <title-info><book-title>T</book-title></title-info>
  <document-info><author><first-name>Doc</first-name><last-name>Info</last-name></author></document-info>
</description>
<body><section><p>hi</p></section></body></FictionBook>`;
  assert.deepEqual(fb2ToIr(buf(src)).authors, [], 'the document-info author does not count');
});

test('fb2ToIr falls back to "Untitled" when there is no book-title', () => {
  const ir = irOf({ desc: '<lang>en</lang>', body: '<section><p>x</p></section>' });
  assert.equal(ir.title, 'Untitled');
});

test('fb2ToIr accumulates a book title that arrives in several text pieces', () => {
  // A CDATA section splits the surrounding text into two SAX events; they must
  // be joined, not overwritten by the second piece.
  assert.equal(irOf({ desc: '<book-title>Part<![CDATA[ ]]>Two</book-title>' }).title, 'PartTwo');
});

// ---- fb2ToIr: binaries and cover ---------------------------------

test('fb2ToIr decodes a binary and links the coverpage image to it', () => {
  const ir = irOf({
    desc: `<book-title>T</book-title>
      <coverpage><image l:href="#pic.png"/></coverpage>`,
    binaries: `<binary id="pic.png" content-type="image/png">${PNG_1x1.toString('base64')}</binary>`,
  });
  assert.equal(ir.images.length, 1);
  assert.equal(ir.images[0].id, 'pic.png');
  assert.equal(ir.images[0].mime, 'image/png');
  assert.ok(ir.images[0].data.equals(PNG_1x1));
  assert.deepEqual(ir.cover, { mime: 'image/png', data: PNG_1x1 }, 'cover resolved from the href');
});

test('fb2ToIr uses the first image as the cover when none is marked', () => {
  const ir = irOf({
    body: '<section><p>x</p></section>',
    binaries: `<binary id="only" content-type="image/gif">${PNG_1x1.toString('base64')}</binary>`,
  });
  assert.deepEqual(ir.cover, { mime: 'image/gif', data: PNG_1x1 });
});

test('fb2ToIr defaults a binary content-type to image/jpeg', () => {
  const ir = irOf({
    body: '<section><p>x</p></section>',
    binaries: `<binary id="x">${PNG_1x1.toString('base64')}</binary>`,
  });
  assert.equal(ir.images[0].mime, 'image/jpeg');
});

// ---- fb2ToIr: body rendering ------------------------------------

test('fb2ToIr makes one chapter per top-level section and a heading from <title>', () => {
  const ir = irOf({
    body: `<section><title><p>One</p></title><p>first</p></section><section><title><p>Two</p></title><p>second</p></section>`,
  });
  assert.deepEqual(ir.chapters, [
    { title: 'One', html: '<p>first</p>' },
    { title: 'Two', html: '<p>second</p>' },
  ]);
});

test('fb2ToIr puts a nested-section title inline as <h2> and separates nested sections with a rule', () => {
  assert.deepEqual(
    irOf({
      body: `<section><title><p>Outer</p></title><p>a</p><section><title><p>Inner</p></title><p>b</p></section></section>`,
    }).chapters,
    [{ title: 'Outer', html: '<p>a</p><hr class="section"/><h2>Inner</h2><p>b</p>' }],
  );
});

test('fb2ToIr maps the inline elements to HTML', () => {
  assert.equal(
    chapterHtml({
      body: `<section><p>a<emphasis>e</emphasis><strong>s</strong><strikethrough>x</strikethrough><sub>d</sub><sup>u</sup><code>c</code></p></section>`,
    }),
    '<p>a<em>e</em><strong>s</strong><s>x</s><sub>d</sub><sup>u</sup><code>c</code></p>',
  );
});

test('fb2ToIr maps the block elements to HTML', () => {
  assert.equal(
    chapterHtml({
      body: `<section><subtitle>sub</subtitle><empty-line/><epigraph><p>epi</p></epigraph><cite><p>cit</p></cite><poem><stanza><v>line one</v><v>line two</v></stanza></poem><text-author>TA</text-author></section>`,
    }),
    '<p class="subtitle">sub</p><br/>' +
      '<blockquote><p>epi</p></blockquote>' +
      '<blockquote><p>cit</p></blockquote>' +
      '<blockquote><p class="stanza"><span class="v">line one</span><br/><span class="v">line two</span><br/></p></blockquote>' +
      '<p class="text-author">TA</p>',
  );
});

test('fb2ToIr rewrites an inline <image> to an <img> into images/', () => {
  assert.equal(
    chapterHtml({ body: `<section><p>see</p><image l:href="#fig1.png"/></section>` }),
    '<p>see</p><img src="images/fig1.png" alt=""/>',
  );
  // an <image> with no href contributes nothing
  assert.equal(chapterHtml({ body: `<section><p>x</p><image/></section>` }), '<p>x</p>');
});

test('fb2ToIr skips a notes / comments body entirely', () => {
  const src = `<?xml version="1.0"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><book-title>T</book-title></title-info></description>
<body><section><title><p>Real</p></title><p>keep</p></section></body>
<body name="notes"><section><title><p>Note</p></title><p>drop</p></section></body>
</FictionBook>`;
  const ir = fb2ToIr(buf(src));
  assert.deepEqual(ir.chapters.map((c) => c.title), ['Real']);
  assert.ok(!ir.chapters.some((c) => /drop/.test(c.html)));
});

test('fb2ToIr yields a single placeholder chapter for a book with no body', () => {
  const ir = irOf({ desc: '<book-title>Empty</book-title>' });
  assert.deepEqual(ir.chapters, [{ title: 'Empty', html: '<p></p>' }]);
});

test('fb2ToIr flushes loose body content that is not wrapped in a section', () => {
  assert.deepEqual(irOf({ body: '<p>loose paragraph</p>' }).chapters, [
    { title: '', html: '<p>loose paragraph</p>' },
  ]);
});

test('fb2ToIr closes a chapter at each top-level section end, not lumping them together', () => {
  const ir = irOf({ body: '<section><p>a</p></section><section><p>b</p></section>' });
  assert.equal(ir.chapters.length, 2, 'one chapter per section');
  assert.deepEqual(ir.chapters.map((c) => c.html), ['<p>a</p>', '<p>b</p>']);
});

test('fb2ToIr keeps a nested section inside its parent chapter, not as its own', () => {
  const ir = irOf({
    body: '<section><p>outer</p><section><p>inner</p></section><p>tail</p></section>',
  });
  assert.equal(ir.chapters.length, 1, 'the nested section does not start a new chapter');
  assert.match(ir.chapters[0].html, /outer.*inner.*tail/s, 'and content after it stays in the same chapter');
});

test('fb2ToIr renders only what is inside a <body>, not stray content around it', () => {
  const src = `<?xml version="1.0"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><book-title>T</book-title></title-info></description>
<subtitle>stray before</subtitle>
<body><section><p>real</p></section></body>
<subtitle>stray after</subtitle>
</FictionBook>`;
  const ir = fb2ToIr(buf(src));
  assert.deepEqual(ir.chapters, [{ title: '', html: '<p>real</p>' }], 'exactly the body content, nothing bracketing it');
});

test('fb2ToIr emits no markup for a body element it does not recognise', () => {
  const html = chapterHtml({ body: '<section><whatnot/><p>real</p></section>' });
  assert.equal(html, '<p>real</p>', 'an unmapped tag adds neither markup nor a stray "undefined"');
});

test('fb2ToIr keeps description text in the field it belongs to', () => {
  const ir = irOf({
    desc: '<book-title>Just The Title</book-title><lang>fr</lang><annotation>an annotation blurb</annotation>',
  });
  assert.equal(ir.title, 'Just The Title', 'the annotation text does not leak into the title');
  assert.equal(ir.language, 'fr', 'nor into the language');
});

test('fb2ToIr: a second title at the same level becomes an <h2>, not the chapter title', () => {
  assert.deepEqual(
    irOf({
      body: '<section><title><p>A</p></title><title><p>B</p></title><p>x</p></section>',
    }).chapters,
    [{ title: 'A', html: '<h2>B</h2><p>x</p>' }],
  );
});

test('fb2ToIr collapses runs of whitespace inside a title', () => {
  assert.deepEqual(
    irOf({ body: '<section><title><p>A     B</p></title><p>x</p></section>' }).chapters.map((c) => c.title),
    ['A B'],
  );
});

test('fb2ToIr does not add spaces around inline tags when collecting title text', () => {
  assert.deepEqual(
    irOf({
      body: '<section><title><p>A<emphasis>B</emphasis>C</p></title><p>x</p></section>',
    }).chapters.map((c) => c.title),
    ['ABC'],
    'only block boundaries inside a title get a separating space',
  );
});

test('fb2ToIr drops an empty nested title rather than emitting <h2></h2>', () => {
  const html = chapterHtml({
    body: '<section><p>a</p><section><title></title><p>b</p></section></section>',
  });
  assert.ok(!/<h2><\/h2>/.test(html), 'no empty heading');
});

test('fb2ToIr: a deeper section title is an inline <h2>, never the chapter title, even when the parent has none', () => {
  assert.deepEqual(
    irOf({
      body: '<section><p>a</p><section><title><p>Deep</p></title><p>b</p></section></section>',
    }).chapters,
    [{ title: '', html: '<p>a</p><hr class="section"/><h2>Deep</h2><p>b</p>' }],
    'the untitled outer section stays untitled; "Deep" is a heading inside it',
  );
});

test('fb2ToIr escapes body text', () => {
  assert.equal(
    chapterHtml({ body: '<section><p>a &amp; b &lt; c &gt; d</p></section>' }),
    '<p>a &amp; b &lt; c &gt; d</p>',
  );
});

test('fb2ToIr collapses a multi-<p> title into one spaced heading and trims the book title', () => {
  const ir = irOf({
    desc: '<book-title>  Spaced Title  </book-title>',
    body: '<section><title><p>Part</p><p>One</p></title><p>x</p></section>',
  });
  assert.equal(ir.title, 'Spaced Title', 'the book title is trimmed');
  assert.deepEqual(ir.chapters.map((c) => c.title), ['Part One'], 'the two title <p>s are joined by a space');
});

test('fb2ToIr normalizes the language and author whitespace', () => {
  const ir = irOf({
    desc: `<book-title>T</book-title><lang>  ru  </lang>
      <author><first-name>Multi   Word</first-name><last-name>Name</last-name></author>`,
  });
  assert.equal(ir.language, 'ru', 'language is trimmed');
  assert.deepEqual(ir.authors, ['Multi Word Name'], 'a run of internal whitespace collapses to one space');
});

test('fb2ToIr falls back to "Untitled" for a whitespace-only book title', () => {
  assert.equal(irOf({ desc: '<book-title>   </book-title>' }).title, 'Untitled');
});

test('fb2ToIr leaves the cover unset from the href when it points at no known image', () => {
  const ir = irOf({
    desc: '<book-title>T</book-title><coverpage><image l:href="#nope"/></coverpage>',
    binaries: `<binary id="real" content-type="image/png">${PNG_1x1.toString('base64')}</binary>`,
  });
  // the href resolved to nothing, so the cover comes from the fallback (images[0])
  assert.ok(ir.cover!.data.equals(PNG_1x1));
});

test('fb2ToIr only strips a body named notes or comments, not any other name', () => {
  const src = (name: string) => `<?xml version="1.0"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><book-title>T</book-title></title-info></description>
<body name="${name}"><section><p>content</p></section></body></FictionBook>`;
  assert.equal(fb2ToIr(buf(src('notes'))).chapters.every((c) => !/content/.test(c.html)), true);
  assert.equal(fb2ToIr(buf(src('comments'))).chapters.every((c) => !/content/.test(c.html)), true);
  assert.match(fb2ToIr(buf(src('main'))).chapters[0].html, /content/, 'a "main" body is rendered');
});

test('fb2ToIr strips whitespace out of a binary payload before decoding', () => {
  const wrapped = PNG_1x1.toString('base64').replace(/(.{8})/g, '$1  \n\t');
  const ir = irOf({
    body: '<section><p>x</p></section>',
    binaries: `<binary id="w" content-type="image/png">${wrapped}</binary>`,
  });
  assert.ok(ir.images[0].data.equals(PNG_1x1), 'newlines in the base64 do not corrupt it');
});

test('fb2ToIr ignores a cover <image> that is not inside <coverpage>', () => {
  const ir = irOf({
    desc: '<book-title>T</book-title><annotation><image l:href="#a"/></annotation>',
    binaries: `<binary id="a" content-type="image/png">${PNG_1x1.toString('base64')}</binary>`,
  });
  // the image still becomes an available image, but the cover falls back to it
  // as images[0] rather than being resolved through a coverpage href
  assert.equal(ir.images.length, 1);
  assert.deepEqual(ir.cover, { mime: 'image/png', data: PNG_1x1 });
});

// ---- irToFb2 -----------------------------------------------------

const withIr = (over: Partial<Ir>): Ir => ({ ...emptyIr(), ...over });

test('irToFb2 splits each author into first / last names, with a fallback', () => {
  const out = irToFb2(withIr({ authors: ['Jane Mary Doe', 'Cher'], chapters: [{ title: '', html: '<p>x</p>' }] }));
  assert.match(out, /<first-name>Jane Mary<\/first-name><last-name>Doe<\/last-name>/);
  assert.match(out, /<first-name>Cher<\/first-name><last-name>Cher<\/last-name>/, 'a mononym fills both');

  // a run of whitespace between name parts still splits into exactly two names
  const spaced = irToFb2(withIr({ authors: ['Ann   Bell'], chapters: [{ title: '', html: '<p>x</p>' }] }));
  assert.match(spaced, /<first-name>Ann<\/first-name><last-name>Bell<\/last-name>/);

  const noAuthors = irToFb2(withIr({ authors: [], chapters: [{ title: '', html: '<p>x</p>' }] }));
  assert.match(noAuthors, /<last-name>Unknown<\/last-name>/);
});

test('irToFb2 concatenates multiple authors with nothing between them', () => {
  const out = irToFb2(withIr({ authors: ['A One', 'B Two'], chapters: [{ title: '', html: '<p>x</p>' }] }));
  assert.match(
    out,
    /<author><first-name>A<\/first-name><last-name>One<\/last-name><\/author><author><first-name>B<\/first-name><last-name>Two<\/last-name><\/author>/,
    'the two <author> elements sit directly next to each other',
  );
});

test('irToFb2 omits the coverpage element entirely when there is no cover', () => {
  const out = irToFb2(withIr({ identifier: 'X', title: 'T', language: 'en', chapters: [{ title: 'C', html: '<p>x</p>' }] }));
  assert.ok(!/coverpage/.test(out), 'no <coverpage>');
  assert.ok(!/<binary/.test(out), 'and no binaries');
  // the slot where <coverpage> would go is empty, not filled with placeholder text
  assert.match(out, /<lang>en<\/lang>\n\n<\/title-info>/);
});

test('irToFb2 carries the title and language, defaulting the language to en', () => {
  const out = irToFb2(withIr({ title: 'My & Book', language: '', chapters: [{ title: '', html: '<p>x</p>' }] }));
  assert.match(out, /<book-title>My &amp; Book<\/book-title>/);
  assert.match(out, /<lang>en<\/lang>/);
  const ru = irToFb2(withIr({ title: 'T', language: 'ru', chapters: [{ title: '', html: '<p>x</p>' }] }));
  assert.match(ru, /<lang>ru<\/lang>/);
});

test('irToFb2 emits a coverpage + binary whose extension follows the mime', () => {
  const mk = (mime: string) =>
    irToFb2(withIr({ cover: { mime, data: PNG_1x1 }, chapters: [{ title: '', html: '<p>x</p>' }] }));
  assert.match(mk('image/png'), /l:href="#cover\.png"/);
  assert.match(mk('image/png'), /<binary id="cover\.png" content-type="image\/png">/);
  assert.match(mk('image/gif'), /l:href="#cover\.gif"/);
  assert.match(mk('image/jpeg'), /l:href="#cover\.jpg"/);
  assert.match(mk('image/webp'), /l:href="#cover\.jpg"/, 'anything else is .jpg');
});

test('irToFb2 does not write the cover image a second time as a plain binary', () => {
  const out = irToFb2(
    withIr({
      cover: { mime: 'image/png', data: PNG_1x1 },
      images: [{ id: 'dup', mime: 'image/png', data: PNG_1x1 }],
      chapters: [{ title: '', html: '<p>x</p>' }],
    }),
  );
  assert.equal(out.match(/<binary /g)!.length, 1, 'just the cover binary');
});

test('irToFb2 writes a title element only when the chapter has one, else an empty section body', () => {
  const out = irToFb2(withIr({ chapters: [{ title: 'Ch', html: '<p>body</p>' }, { title: '', html: '' }] }));
  assert.match(out, /<section><title><p>Ch<\/p><\/title><p>body<\/p><\/section>/);
  assert.match(out, /<section><empty-line\/><\/section>/, 'an empty chapter still produces a section');
});

test('irToFb2 produces the exact document for a fully-populated IR', () => {
  const out = irToFb2({
    ...emptyIr(),
    identifier: 'X',
    title: 'T',
    language: 'en',
    authors: ['A B'],
    images: [{ id: 'i1', mime: 'image/png', data: Buffer.from('PNGDATA') }],
    cover: { mime: 'image/png', data: Buffer.from('COVER') },
    chapters: [
      { title: 'C1', html: '<p>one</p>' },
      { title: '', html: '' },
    ],
  });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(
    out,
    `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
<title-info>
<genre>prose</genre>
<author><first-name>A</first-name><last-name>B</last-name></author>
<book-title>T</book-title>
<lang>en</lang>
<coverpage><image l:href="#cover.png"/></coverpage>
</title-info>
<document-info>
<author><nickname>sopds</nickname></author>
<program-used>sopds-convert</program-used>
<date>${today}</date>
<id>X</id>
<version>1.0</version>
</document-info>
</description>
<body>
<section><title><p>C1</p></title><p>one</p></section>
<section><empty-line/></section>
</body>
<binary id="cover.png" content-type="image/png">Q09WRVI=</binary>
<binary id="i1" content-type="image/png">UE5HREFUQQ==</binary>
</FictionBook>`,
  );
});

test('htmlFragmentToFb2 translates every HTML construct to its FB2 equivalent', () => {
  const f = htmlFragmentToFb2;
  assert.equal(f('<p><em>a</em><i>b</i></p>'), '<p><emphasis>a</emphasis><emphasis>b</emphasis></p>');
  assert.equal(f('<p><strong>a</strong><b>c</b></p>'), '<p><strong>a</strong><strong>c</strong></p>');
  assert.equal(f('<p><img src="images/p.jpg"/>x</p>'), '<p><image l:href="#p.jpg"/>x</p>');
  assert.equal(f('<p><img src="http://x/y.png"/>x</p>'), '<p>x</p>', 'a non-local img is dropped');
  assert.equal(f('<h3>Head</h3><p>x</p>'), '<subtitle>Head</subtitle><p>x</p>');
  assert.equal(f('<p>a<br/>b</p>'), '<p>a<empty-line/>b</p>');
  assert.equal(f('<p>a</p><hr/><p>b</p>'), '<p>a</p><empty-line/><p>b</p>');
  assert.equal(f('<blockquote><p>q</p></blockquote>'), '<cite><p>q</p></cite>');
  assert.equal(f('<div>d</div><p>p</p>'), '<p>d</p><p>p</p>');
  assert.equal(f('<p><span class="x">s</span>t</p>'), '<p>st</p>', 'an unknown tag is stripped');
});

test('htmlFragmentToFb2 handles tags that carry attributes, not just bare ones', () => {
  const f = htmlFragmentToFb2;
  assert.equal(
    f('<p><img   src="images/p.jpg" title="a pic" width="10"/>x</p>'),
    '<p><image l:href="#p.jpg"/>x</p>',
    'an images/ img with extra whitespace and attributes is still converted',
  );
  assert.equal(f('<p>a<br>b</p>'), '<p>a<empty-line/>b</p>', 'a bare <br> (no slash) converts too');
  assert.equal(
    f('<p><img src="http://x/y.png" alt="remote" data-k="v"/>x</p>'),
    '<p>x</p>',
    'a remote img with extra attributes is still dropped',
  );
  assert.equal(f('<h2 id="c1" class="head">H</h2><p>x</p>'), '<subtitle>H</subtitle><p>x</p>');
  assert.equal(f('<p>a<br />b</p>'), '<p>a<empty-line/>b</p>', 'a spaced self-closing br still converts');
  assert.equal(f('<p>a</p><hr class="rule" data-x="1"/><p>b</p>'), '<p>a</p><empty-line/><p>b</p>');
  assert.equal(
    f('<blockquote cite="src" class="q"><p>x</p></blockquote>'),
    '<cite><p>x</p></cite>',
  );
  assert.equal(f('<div class="c" id="d">t</div><p>p</p>'), '<p>t</p><p>p</p>');
});

test('htmlFragmentToFb2 falls back to paragraph splitting when the HTML has no <p>', () => {
  assert.equal(htmlFragmentToFb2('line one<br>line two'), '<p>line one</p><p>line two</p>');
  assert.equal(htmlFragmentToFb2(''), '', 'nothing in, nothing out');
});

test('extForMime picks the file extension from the image mime', () => {
  assert.equal(extForMime('image/png'), '.png');
  assert.equal(extForMime('image/gif'), '.gif');
  assert.equal(extForMime('image/jpeg'), '.jpg');
  assert.equal(extForMime('image/webp'), '.jpg', 'anything else is .jpg');
});
