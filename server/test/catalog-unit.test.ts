import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SOPDS_TEST_DB ??= 'mem';

const {
  clampPage,
  clampLimit,
  paginate,
  pageMeta,
  groupByBook,
  stripTags,
  escapeLike,
  searchTerm,
  quickCap,
  collapseDoubles,
  partialPage,
} = await import('../src/services/catalog.js');
const { setOverride } = await import('../src/services/settings.js');

// The pure paging/matching helpers behind the catalog queries. The SQL paths
// are covered by search.test.ts / browse.test.ts.

test('clampPage: a positive integer, else 1', () => {
  assert.equal(clampPage(3), 3);
  assert.equal(clampPage('4'), 4);
  assert.equal(clampPage('4abc'), 4, 'parseInt of a trailing-junk string');
  assert.equal(clampPage(1), 1, 'exactly 1 is kept');
  assert.equal(clampPage(0), 1, '0 -> 1');
  assert.equal(clampPage(-2), 1);
  assert.equal(clampPage('nope'), 1);
  assert.equal(clampPage(undefined), 1);
  assert.equal(clampPage(2.9), 2, 'parseInt truncates');
});

test('clampLimit: a positive integer capped at 200, else the configured default', () => {
  setOverride('maxItems', 50);
  assert.equal(clampLimit(20), 20);
  assert.equal(clampLimit('20'), 20);
  assert.equal(clampLimit(1), 1, 'exactly 1 is kept');
  assert.equal(clampLimit(200), 200, 'exactly the cap');
  assert.equal(clampLimit(201), 200, 'over the cap');
  assert.equal(clampLimit(99999), 200);
  assert.equal(clampLimit(0), 50, '0 -> default');
  assert.equal(clampLimit(-5), 50);
  assert.equal(clampLimit('junk'), 50);
  assert.equal(clampLimit(undefined), 50);
  setOverride('maxItems', 30);
  assert.equal(clampLimit(0), 30, 'follows the live setting');
  setOverride('maxItems', undefined as never);
});

test('paginate combines the clamps into a zero-based offset', () => {
  assert.deepEqual(paginate(1, 20), { page: 1, limit: 20, offset: 0 });
  assert.deepEqual(paginate(3, 20), { page: 3, limit: 20, offset: 40 });
  assert.deepEqual(paginate(0, 0), { page: 1, limit: clampLimit(0), offset: 0 }, 'bad inputs fall back');
});

test('pageMeta: page count, has_next and has_prev', () => {
  assert.deepEqual(pageMeta(0, 1, 20), { total: 0, page: 1, limit: 20, pages: 1, has_next: false, has_prev: false });
  assert.deepEqual(pageMeta(45, 2, 20), { total: 45, page: 2, limit: 20, pages: 3, has_next: true, has_prev: true });
  assert.deepEqual(pageMeta(40, 2, 20), { total: 40, page: 2, limit: 20, pages: 2, has_next: false, has_prev: true });
  assert.equal(pageMeta(1, 1, 20).pages, 1, 'at least one page even for a tiny total');
  assert.equal(pageMeta(20, 1, 20).has_next, false, 'exactly one full page -> no next');
  assert.equal(pageMeta(21, 1, 20).has_next, true);
});

test('groupByBook buckets rows by book_id and strips the key', () => {
  const m = groupByBook([
    { book_id: 1, name: 'a' },
    { book_id: 2, name: 'b' },
    { book_id: 1, name: 'c' },
  ]);
  assert.deepEqual(m.get(1), [{ name: 'a' }, { name: 'c' }], 'order preserved within a bucket');
  assert.deepEqual(m.get(2), [{ name: 'b' }]);
  assert.equal(m.size, 2);
  assert.deepEqual(groupByBook([]), new Map());
});

test('stripTags removes angle-bracket tags and trims', () => {
  assert.equal(stripTags('<p>hello <b>world</b></p>'), 'hello world');
  assert.equal(stripTags('  <br/> spaced <i></i> '), 'spaced');
  assert.equal(stripTags('no tags here'), 'no tags here');
  assert.equal(stripTags('<x>'), '');
  assert.equal(stripTags('a<b>c'), 'ac', 'anything between < and > goes');
  assert.equal(stripTags('less < than only'), 'less < than only', 'an unclosed < is left alone');
});

test('escapeLike escapes the three LIKE metacharacters', () => {
  assert.equal(escapeLike('100%'), '100\\%');
  assert.equal(escapeLike('a_b'), 'a\\_b');
  assert.equal(escapeLike('back\\slash'), 'back\\\\slash');
  assert.equal(escapeLike('%_\\'), '\\%\\_\\\\');
  assert.equal(escapeLike('plain'), 'plain');
});

test('searchTerm: exact -> the normalized term; all -> a LIKE pattern with metacharacters escaped', () => {
  assert.equal(searchTerm('War & Peace', 'exact'), 'WAR & PEACE', 'uppercased, no wrapping');
  assert.equal(searchTerm('War & Peace'), '%WAR & PEACE%', 'default is a substring pattern');
  assert.equal(searchTerm('War & Peace', 'all'), '%WAR & PEACE%');
  assert.equal(searchTerm('50%_off', 'all'), '%50\\%\\_OFF%', 'literal % and _ inside the pattern');
  assert.equal(searchTerm('50%_off', 'exact'), '50%_OFF', 'exact term is bound as typed');
});

test('quickCap: five times the limit, but never below 200', () => {
  assert.equal(quickCap(10), 200, '50 < 200 -> 200');
  assert.equal(quickCap(40), 200, 'exactly 200');
  assert.equal(quickCap(50), 250);
  assert.equal(quickCap(1), 200);
});

test('collapseDoubles keeps the first of each title+author-set group and counts the rest', () => {
  const mk = (id: number, title: string, authors: number[]): any => ({
    id,
    title,
    authors: authors.map((a) => ({ id: a })),
  });
  const out = collapseDoubles([
    mk(1, 'Dune', [7]),
    mk(2, 'Dune', [7]), // same title + author set -> a double of #1
    mk(3, 'dune', [7]), // case-folded title also collapses
    mk(4, 'Dune', [8]), // different author -> its own group
    mk(5, 'Foundation', [7]),
  ]);
  assert.deepEqual(out.map((b) => b.id), [1, 4, 5]);
  assert.equal(out[0].doubles, 2, 'two extra editions of Dune/[7]');
  assert.equal(out[1].doubles, 0);
  assert.equal(out[2].doubles, 0);
});

test('collapseDoubles ignores author order when grouping', () => {
  const mk = (id: number, authors: number[]): any => ({ id, title: 'T', authors: authors.map((a) => ({ id: a })) });
  const out = collapseDoubles([mk(1, [3, 1, 2]), mk(2, [2, 3, 1])]);
  assert.equal(out.length, 1, 'same author set in a different order is still a double');
});

test('collapseDoubles keeps a separator between author ids so [1,2] != [12]', () => {
  const mk = (id: number, authors: number[]): any => ({ id, title: 'T', authors: authors.map((a) => ({ id: a })) });
  const out = collapseDoubles([mk(1, [1, 2]), mk(2, [12])]);
  assert.equal(out.length, 2, "'1,2' and '12' are different author sets, not a double");
});

test('partialPage: a single page whose total is only what was found', () => {
  const p = partialPage([{ x: 1 }, { x: 2 }], 20);
  assert.deepEqual(p, {
    items: [{ x: 1 }, { x: 2 }],
    total: 2,
    page: 1,
    limit: 20,
    pages: 1,
    has_next: false,
    has_prev: false,
    partial: true,
  });
});
