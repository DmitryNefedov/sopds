import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xmlEscape, feed, navEntry, bookEntry, rootFeed } from '../src/routes/opds.js';
import type { Book, Stats } from '../src/types.js';

// ---- xmlEscape --------------------------------------------------------

test('xmlEscape replaces every metacharacter and coerces nullish to ""', () => {
  assert.equal(xmlEscape('a & b < c > d " e'), 'a &amp; b &lt; c &gt; d &quot; e');
  assert.equal(xmlEscape(null), '');
  assert.equal(xmlEscape(undefined), '');
  assert.equal(xmlEscape(0), '0', '0 is kept, not turned into ""');
  assert.equal(xmlEscape(false), 'false');
  // ampersand is escaped first, so an already-escaped entity is not double-counted wrongly
  assert.equal(xmlEscape('&lt;'), '&amp;lt;');
  // every occurrence, not just the first
  assert.equal(xmlEscape('<<>>'), '&lt;&lt;&gt;&gt;');
});

// ---- feed ------------------------------------------------------------

const FEED = feed({
  id: 'sopds:test',
  title: 'The "Test" & <Feed>',
  self: '/opds/test?x=1&y=2',
  links: ['<link rel="up" href="/opds/"/>'],
  entries: ['<entry>one</entry>', '<entry>two</entry>'],
});

test('feed emits a well-formed Atom document with escaped id/title/self', () => {
  assert.match(FEED, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<feed /);
  assert.match(FEED, /<id>sopds:test<\/id>/);
  assert.match(FEED, /<title>The &quot;Test&quot; &amp; &lt;Feed&gt;<\/title>/);
  assert.match(FEED, /<link rel="self" href="\/opds\/test\?x=1&amp;y=2" type="application\/atom\+xml;profile=opds-catalog;kind=navigation"\/>/);
  assert.match(FEED, /<link rel="start" href="\/opds\/" type="application\/atom\+xml;profile=opds-catalog;kind=navigation"\/>/);
  assert.match(FEED, /<link rel="search" href="\/opds\/search\?q=\{searchTerms\}" type="application\/atom\+xml;profile=opds-catalog;kind=acquisition"\/>/);
  assert.ok(FEED.includes('<link rel="up" href="/opds/"/>'), 'extra links are appended');
  assert.ok(FEED.includes('<entry>one</entry>\n  <entry>two</entry>'), 'entries joined with a newline+indent');
  assert.match(FEED, /<updated>\d{4}-\d\d-\d\dT[\d:.]+Z<\/updated>/);
});

test('feed defaults links to an empty list and joins links with a newline+indent', () => {
  const f = feed({ id: 'i', title: 't', self: '/s', entries: [] });
  assert.ok(f.includes('<id>i</id>'));
  assert.equal((f.match(/<link /g) || []).length, 3);
  assert.ok(!f.includes('Stryker'), 'the default links array is genuinely empty');
  assert.match(f, /kind=navigation"\/>\n  <link rel="start"/, 'links are newline+two-space separated');
  assert.match(f, /kind=acquisition"\/>\n  \n/, 'nothing but the three links, then the (empty) entries');
});

// ---- rootFeed ----------------------------------------------------

const stats = (over: Partial<Stats> = {}): Stats => ({
  allbooks: 12,
  allcatalogs: 3,
  allauthors: 7,
  allgenres: 5,
  allseries: 2,
  lastscan: null,
  ...over,
});

test('rootFeed links the four browse axes, each entry carrying its live count', () => {
  const xml = rootFeed('My Library', stats());
  assert.match(xml, /<id>sopds:root<\/id>/);
  assert.match(xml, /<title>My Library<\/title>/);
  assert.match(xml, /<link rel="self" href="\/opds\/" /);
  for (const [id, title, href, content] of [
    ['nav:catalogs', 'By catalogs', '/opds/catalogs', 'Catalogs: 3, books: 12'],
    ['nav:authors', 'By authors', '/opds/authors', 'Authors: 7'],
    ['nav:series', 'By series', '/opds/series', 'Series: 2'],
    ['nav:genres', 'By genres', '/opds/genres', 'Genres: 5'],
  ]) {
    assert.ok(xml.includes(`<id>${id}</id>`), id);
    assert.ok(xml.includes(`<title>${title}</title>`), title);
    assert.ok(xml.includes(`href="${href}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>`), href);
    assert.ok(xml.includes(`<content type="text">${content}</content>`), content);
  }
});

test('rootFeed shows 0 for a stat that has no counter row yet', () => {
  const xml = rootFeed('L', stats({ allcatalogs: undefined, allbooks: undefined, allauthors: undefined, allseries: undefined, allgenres: undefined }));
  assert.ok(xml.includes('<content type="text">Catalogs: 0, books: 0</content>'));
  assert.ok(xml.includes('<content type="text">Authors: 0</content>'));
  assert.ok(xml.includes('<content type="text">Series: 0</content>'));
  assert.ok(xml.includes('<content type="text">Genres: 0</content>'));
});

// ---- navEntry ------------------------------------------------------

test('navEntry renders a subsection entry, falling back to the title for content', () => {
  const e = navEntry({ id: 'nav:x', title: 'Title & Co', href: '/opds/x?a=1&b=2' });
  assert.match(e, /<id>nav:x<\/id>/);
  assert.match(e, /<title>Title &amp; Co<\/title>/);
  assert.match(e, /<link rel="subsection" href="\/opds\/x\?a=1&amp;b=2" type="application\/atom\+xml;profile=opds-catalog;kind=navigation"\/>/);
  assert.match(e, /<content type="text">Title &amp; Co<\/content>/, 'content defaults to the title');

  const withContent = navEntry({ id: 'i', title: 'T', href: '/h', content: 'Books: 5' });
  assert.match(withContent, /<content type="text">Books: 5<\/content>/);
});

test('navEntry: an empty-string content still falls back to the title', () => {
  const e = navEntry({ id: 'i', title: 'Fallback', href: '/h', content: '' });
  assert.match(e, /<content type="text">Fallback<\/content>/);
});

// ---- bookEntry ----------------------------------------------------

const book = (over: Partial<Book> = {}): Book => ({
  id: 7,
  title: 'A Book',
  filename: 'a.fb2',
  path: 'shelf',
  format: 'fb2',
  filesize: 1,
  cat_type: 0,
  lang: 'en',
  lang_code: 0,
  doc_date: '',
  register_date: '',
  annotation: '',
  catalog_id: null,
  zip_offset: null,
  zip_csize: null,
  zip_method: null,
  authors: [{ id: 1, full_name: 'Jane Roe' }],
  genres: [{ id: 1, genre: 'sf', section: 'Fiction', subsection: 'Science Fiction' }],
  series: [],
  ...over,
});

test('bookEntry lists the native format plus every convertible target, with escaped metadata', () => {
  const e = bookEntry(book({ title: 'Tom & Jerry', annotation: 'About <b>it</b>.' }));
  assert.match(e, /<id>book:7<\/id>/);
  assert.match(e, /<title>Tom &amp; Jerry<\/title>/);
  assert.match(e, /<author><name>Jane Roe<\/name><\/author>/);
  assert.match(e, /<category term="Science Fiction"\/>/);
  assert.match(e, /<link rel="http:\/\/opds-spec\.org\/image" href="\/api\/books\/7\/cover" type="image\/jpeg"\/>/);
  assert.match(e, /<content type="text">About &lt;b&gt;it&lt;\/b&gt;\.<\/content>/);

  const hrefs = [...e.matchAll(/acquisition\/open-access" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [
    '/api/books/7/download?format=fb2',
    '/api/books/7/download?format=epub',
    '/api/books/7/download?format=mobi',
  ]);
  // acquisition links are newline+indent separated, nothing between them
  assert.match(e, /format=fb2"[^\n]*\/>\n    <link rel="http:\/\/opds-spec\.org\/acquisition/);
  assert.ok(!e.includes('Stryker'));
});

test('bookEntry: a non-convertible source format offers only the native file', () => {
  const e = bookEntry(book({ format: 'pdf' }));
  const hrefs = [...e.matchAll(/acquisition\/open-access" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ['/api/books/7/download?format=pdf']);
});

test('bookEntry: the content falls back to the title when there is no annotation', () => {
  assert.match(bookEntry(book({ title: 'Untitled Work', annotation: '' })), /<content type="text">Untitled Work<\/content>/);
});

test('bookEntry: multiple authors and genres each get their own element', () => {
  const e = bookEntry(
    book({
      authors: [
        { id: 1, full_name: 'A One' },
        { id: 2, full_name: 'B Two' },
      ],
      genres: [
        { id: 1, genre: 'sf', section: 'F', subsection: 'SF' },
        { id: 2, genre: 'det', section: 'F', subsection: 'Detective' },
      ],
    }),
  );
  assert.equal((e.match(/<author>/g) || []).length, 2);
  assert.match(e, /<\/author><author>/, 'authors are concatenated with no separator');
  assert.ok(e.includes('<category term="SF"/><category term="Detective"/>'));
  assert.ok(!e.includes('Stryker'));
});
