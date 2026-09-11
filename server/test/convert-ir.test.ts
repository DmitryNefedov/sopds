import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyIr,
  mimeFromName,
  extFromMime,
  escapeXml,
  sanitizeHtml,
  balanceHtml,
  htmlToParagraphs,
} from '../src/services/convert/ir.js';

// The shared IR helpers - all pure string / object work.

test('emptyIr is a blank book with a unique-ish identifier', () => {
  const a = emptyIr();
  assert.equal(a.title, 'Untitled');
  assert.equal(a.language, '');
  assert.match(a.identifier, /^sopds-\d+$/);
  assert.deepEqual(a.authors, []);
  assert.equal(a.cover, null);
  assert.deepEqual(a.chapters, []);
  assert.deepEqual(a.images, []);
});

test('mimeFromName maps each known extension, case-insensitively, else image/jpeg', () => {
  assert.equal(mimeFromName('cover.jpg'), 'image/jpeg');
  assert.equal(mimeFromName('cover.jpeg'), 'image/jpeg');
  assert.equal(mimeFromName('cover.png'), 'image/png');
  assert.equal(mimeFromName('cover.gif'), 'image/gif');
  assert.equal(mimeFromName('cover.svg'), 'image/svg+xml');
  assert.equal(mimeFromName('cover.webp'), 'image/webp');
  assert.equal(mimeFromName('COVER.PNG'), 'image/png', 'extension match is case-insensitive');
  assert.equal(mimeFromName('photo.tiff'), 'image/jpeg', 'unknown extension falls back');
  assert.equal(mimeFromName('noext'), 'image/jpeg', 'no extension falls back');
  assert.equal(mimeFromName('a.png.bak'), 'image/jpeg', 'only the final extension counts');
});

test('extFromMime is the inverse for known mimes, else .jpg', () => {
  assert.equal(extFromMime('image/jpeg'), '.jpg');
  assert.equal(extFromMime('image/png'), '.png');
  assert.equal(extFromMime('image/gif'), '.gif');
  assert.equal(extFromMime('image/svg+xml'), '.svg');
  assert.equal(extFromMime('image/webp'), '.webp');
  assert.equal(extFromMime('application/octet-stream'), '.jpg', 'unknown mime falls back');
});

test('escapeXml replaces all five markup characters and coerces nullish to empty', () => {
  assert.equal(escapeXml('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
  assert.equal(escapeXml('&'), '&amp;');
  assert.equal(escapeXml('<'), '&lt;');
  assert.equal(escapeXml('>'), '&gt;');
  assert.equal(escapeXml('"'), '&quot;');
  assert.equal(escapeXml("'"), '&apos;');
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(undefined), '');
  assert.equal(escapeXml(42), '42');
});

test('sanitizeHtml drops the things that must not travel between formats', () => {
  assert.equal(sanitizeHtml('<?xml version="1.0"?>keep'), 'keep', 'processing instruction');
  assert.equal(sanitizeHtml('a<!-- secret -->b'), 'ab', 'comment');
  assert.equal(sanitizeHtml('x<script>evil()</script>y'), 'xy', 'script element');
  assert.equal(sanitizeHtml('x<SCRIPT>evil()</SCRIPT>y'), 'xy', 'script element, upper case');
  assert.equal(
    sanitizeHtml('x<script>\n  multi\n  line\n</script>y'),
    'xy',
    'a script spanning several lines is still removed whole',
  );
  assert.equal(sanitizeHtml('x<style>p{}</style>y'), 'xy', 'style element');
  assert.equal(sanitizeHtml('x<style>\n p { }\n</style>y'), 'xy', 'a multi-line style too');
  assert.equal(sanitizeHtml('<p onclick="boom()">hi</p>'), '<p>hi</p>', 'double-quoted handler');
  assert.equal(sanitizeHtml("<p onload='boom()'>hi</p>"), '<p>hi</p>', 'single-quoted handler');
  assert.equal(
    sanitizeHtml('<p onclick = "boom()">hi</p>'),
    '<p>hi</p>',
    'spaces around the = in a handler do not save it',
  );
  assert.equal(sanitizeHtml("<p onload = 'boom()'>hi</p>"), '<p>hi</p>', 'and the single-quoted variant');
  assert.equal(sanitizeHtml('  <p>trimmed</p>  '), '<p>trimmed</p>', 'trimmed');
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(undefined), '');
});

test('balanceHtml self-closes every void element', () => {
  for (const t of ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']) {
    assert.equal(balanceHtml(`<${t}>`), `<${t}/>`, `<${t}> is void`);
  }
  assert.equal(balanceHtml('<br/>'), '<br/>', 'an already self-closed void tag is left alone');
  assert.equal(balanceHtml('<img src="a&b">'), '<img src="a&amp;b"/>', 'and its attributes are still fixed');
});

test('balanceHtml opens and closes non-void tags in order', () => {
  assert.equal(balanceHtml('</p><p>hi</p>'), '<p>hi</p>');
  assert.equal(balanceHtml('<p>hi'), '<p>hi</p>');
  assert.equal(balanceHtml('<p><em>hi</p>'), '<p><em>hi</em></p>');
  assert.equal(balanceHtml('<div><p>a</div>b'), '<div><p>a</p></div>b');
  assert.equal(balanceHtml('<p/>after'), '<p/>after', 'a self-closed non-void tag is not pushed as open');
});

test('balanceHtml / fixEntities: keep valid references, rewrite named ones, escape bare &', () => {
  assert.equal(balanceHtml('a & b'), 'a &amp; b');
  assert.equal(balanceHtml('Tom & Jerry & Co'), 'Tom &amp; Jerry &amp; Co');
  assert.equal(balanceHtml('&amp; &lt; &gt; &quot; &apos;'), '&amp; &lt; &gt; &quot; &apos;');
  assert.equal(balanceHtml('&#160; &#x41; &#8212;'), '&#160; &#x41; &#8212;', 'numeric refs kept');
  assert.equal(balanceHtml('&frobnicate;'), '&amp;frobnicate;', 'an unknown named entity is defused');
  assert.equal(balanceHtml('&xamp;'), '&amp;xamp;', 'a token that merely ends in a valid name is not one');
});

test('balanceHtml maps every named entity it knows to its numeric form', () => {
  const cases: Record<string, string> = {
    nbsp: '#160', copy: '#169', reg: '#174', deg: '#176', middot: '#183',
    ndash: '#8211', mdash: '#8212', lsquo: '#8216', rsquo: '#8217',
    ldquo: '#8220', rdquo: '#8221', bull: '#8226', hellip: '#8230',
    laquo: '#171', raquo: '#187', trade: '#8482', euro: '#8364',
    pound: '#163', sect: '#167', para: '#182', times: '#215', divide: '#247',
  };
  for (const [name, num] of Object.entries(cases)) {
    assert.equal(balanceHtml(`x&${name};y`), `x&${num};y`, `&${name}; -> &${num};`);
  }
});

test('htmlToParagraphs turns block boundaries into paragraphs and decodes entities', () => {
  assert.deepEqual(htmlToParagraphs('<p>one</p><p>two</p>'), ['one', 'two']);
  assert.deepEqual(htmlToParagraphs('<p>a</p><div>b</div><h2>c</h2><li>d</li>'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(htmlToParagraphs('line one<br>line two<br/>line three<br />line four'), [
    'line one',
    'line two',
    'line three',
    'line four',
  ]);
  assert.deepEqual(htmlToParagraphs('<p>strip <b>bold</b> tags</p>'), ['strip bold tags']);
  assert.deepEqual(htmlToParagraphs('<p>a&nbsp;b &amp; c &lt;d&gt; &quot;e&quot; &#65;</p>'), [
    'a b & c <d> "e" A',
  ]);
  assert.deepEqual(htmlToParagraphs('   <p>  </p>  <p>real</p>'), ['real'], 'blank paragraphs dropped');
  assert.deepEqual(htmlToParagraphs(null), []);
  assert.deepEqual(htmlToParagraphs(undefined), []);
  assert.deepEqual(htmlToParagraphs(''), []);
});

test('htmlToParagraphs closing-h regex covers h1..h6 only', () => {
  assert.deepEqual(htmlToParagraphs('a</h1>b</h6>c'), ['a', 'b', 'c']);
  // </h7> is not a heading close: it is stripped as a tag but does not split.
  assert.deepEqual(htmlToParagraphs('a</h7>b'), ['ab']);
});
