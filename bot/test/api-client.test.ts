import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogClient } from '../src/api-client.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('titlePrefixSearch hits GET /api/books?prefix=... and returns the page as-is', async () => {
  const page = { items: [{ id: 1 }], total: 1, page: 1, limit: 5, pages: 1, has_next: false, has_prev: false };
  let seen: URL | null = null;
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async (input: string) => {
      seen = new URL(input);
      return json(page);
    }) as typeof fetch,
  });
  const result = await client.titlePrefixSearch('hob', 1, 5);
  assert.deepEqual(result, page);
  assert.equal(seen!.pathname, '/api/books');
  assert.equal(seen!.searchParams.get('prefix'), 'hob');
  assert.equal(seen!.searchParams.get('page'), '1');
  assert.equal(seen!.searchParams.get('limit'), '5');
});

test('titleAnywhereSearch hits GET /api/search?type=books&match=all and unwraps `results`', async () => {
  const page = { items: [{ id: 2 }], total: 1, page: 1, limit: 5, pages: 1, has_next: false, has_prev: false };
  let seen: URL | null = null;
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async (input: string) => {
      seen = new URL(input);
      return json({ query: 'hob', type: 'books', match: 'all', results: page });
    }) as typeof fetch,
  });
  const result = await client.titleAnywhereSearch('hob', 1, 5);
  assert.deepEqual(result, page);
  assert.equal(seen!.searchParams.get('type'), 'books');
  assert.equal(seen!.searchParams.get('match'), 'all');
});

test('titleAnywhereSearch returns an empty page when `results` is null (empty query)', async () => {
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () => json({ query: '', type: 'books', match: 'all', results: null })) as typeof fetch,
  });
  const result = await client.titleAnywhereSearch('', 1, 5);
  assert.deepEqual(result, { items: [], total: 0, page: 1, limit: 5, pages: 1, has_next: false, has_prev: false });
});

test('getBook returns null on a 404 instead of throwing', async () => {
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () => json({ error: 'not found' }, 404)) as typeof fetch,
  });
  assert.equal(await client.getBook(999), null);
});

test('getBook returns the parsed book on success', async () => {
  const b = { id: 5, title: 'T' };
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () => json(b)) as typeof fetch,
  });
  assert.deepEqual(await client.getBook(5), b);
});

test('a non-404 error status throws', async () => {
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () => json({ error: 'boom' }, 500)) as typeof fetch,
  });
  await assert.rejects(() => client.getBook(5));
});

test('downloadUrl points at the right endpoint, base URL trailing slash stripped', () => {
  const client = new CatalogClient({ baseUrl: 'http://api.local/' });
  assert.equal(client.downloadUrl(7, 'epub'), 'http://api.local/api/books/7/download?format=epub');
});

test('getCoverBytes hits GET /api/books/:id/cover and returns the bytes', async () => {
  let seen: URL | null = null;
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async (input: string) => {
      seen = new URL(input);
      return new Response(Buffer.from('cover bytes'), { status: 200 });
    }) as typeof fetch,
  });
  const bytes = await client.getCoverBytes(7);
  assert.deepEqual(bytes, Buffer.from('cover bytes'));
  assert.equal(seen!.pathname, '/api/books/7/cover');
});

test('getCoverBytes returns null on a 404 (the book itself is gone) instead of throwing', async () => {
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () => json({ error: 'not found' }, 404)) as typeof fetch,
  });
  assert.equal(await client.getCoverBytes(999), null);
});

test('getCoverBytes throws on a non-404 error status', async () => {
  const client = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () => json({ error: 'boom' }, 500)) as typeof fetch,
  });
  await assert.rejects(() => client.getCoverBytes(7));
});
