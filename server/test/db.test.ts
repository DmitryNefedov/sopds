import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// The query surface rewrites `?` / `@name` placeholders into Postgres' `$n` and
// coerces the parameter types the call sites actually pass. These pin that
// translation down, plus the transaction handles the scanner drives by hand.

process.env.SOPDS_TEST_DB ??= 'mem';

const { default: db } = await import('../src/db/index.js');
const { initSchema, updateCounters } = await import('../src/db/schema.js');

before(async () => {
  await initSchema();
  await db.exec('TRUNCATE books, authors, counters RESTART IDENTITY CASCADE');
});

after(async () => {
  await db.end();
});

test('positional ? parameters are bound in order', async () => {
  const row = await db.get<{ a: number; b: string }>('SELECT ?::int AS a, ?::text AS b', [1, 'x']);
  assert.deepEqual(row, { a: 1, b: 'x' });
});

test('a named parameter used twice is bound once', async () => {
  const row = await db.get<{ a: string; b: string }>('SELECT @n AS a, @n AS b', { n: 7 });
  assert.deepEqual(row, { a: '7', b: '7' });
});

test('a :: cast beside a named parameter is left alone', async () => {
  const row = await db.get<{ a: number; b: string }>(
    'SELECT @n::int AS a, @s::text AS b',
    { n: 7, s: '7' },
  );
  assert.deepEqual(row, { a: 7, b: '7' });
});

test('booleans become 0/1 and undefined becomes NULL', async () => {
  const row = await db.get<{ t: number; f: number; u: null }>(
    'SELECT ?::int AS t, ?::int AS f, ?::int AS u',
    [true, false, undefined],
  );
  assert.deepEqual(row, { t: 1, f: 0, u: null });
});

test('get returns undefined for an empty result and all returns []', async () => {
  assert.equal(await db.get('SELECT 1 WHERE false'), undefined);
  assert.deepEqual(await db.all('SELECT 1 WHERE false'), []);
});

test('run reports how many rows a statement touched', async () => {
  await db.run(
    "INSERT INTO authors (full_name, search_full_name) VALUES (?, ?), (?, ?)",
    ['Ivan', 'IVAN', 'Petr', 'PETR'],
  );
  const r = await db.run('UPDATE authors SET lang_code = ? WHERE full_name LIKE ?', [1, '%']);
  assert.equal(r.rowCount, 2);
  const sel = await db.run('SELECT full_name FROM authors WHERE full_name LIKE ?', ['%']);
  assert.deepEqual(new Set(sel.rows.map((x: any) => x.full_name)), new Set(['Ivan', 'Petr']));
});

test('query returns the rows and the affected-row count', async () => {
  const r = await db.query('SELECT ?::int AS n', [5]);
  assert.deepEqual(r.rows, [{ n: 5 }]);
  assert.equal(typeof r.rowCount, 'number');
});

test('tx commits on success and rolls back on throw', async () => {
  await db.tx((cx) =>
    cx.run('INSERT INTO authors (full_name, search_full_name) VALUES (?, ?)', ['Anna', 'ANNA']),
  );
  await assert.rejects(
    db.tx(async (cx) => {
      await cx.run('INSERT INTO authors (full_name, search_full_name) VALUES (?, ?)', [
        'Boris',
        'BORIS',
      ]);
      throw new Error('nope');
    }),
  );
  const names = await db.all<{ full_name: string }>('SELECT full_name FROM authors');
  const set = new Set(names.map((n) => n.full_name));
  assert.ok(set.has('Anna'));
  assert.ok(!set.has('Boris'));
});

test('a hand-driven transaction is invisible until it commits', async () => {
  const tx = await db.begin();
  await tx.run('INSERT INTO authors (full_name, search_full_name) VALUES (?, ?)', ['Zoya', 'ZOYA']);
  await tx.commit();
  assert.ok(await db.get('SELECT 1 FROM authors WHERE full_name = ?', ['Zoya']));

  const rolled = await db.begin();
  await rolled.run('INSERT INTO authors (full_name, search_full_name) VALUES (?, ?)', [
    'Gleb',
    'GLEB',
  ]);
  await rolled.rollback();
  assert.equal(await db.get('SELECT 1 FROM authors WHERE full_name = ?', ['Gleb']), undefined);
});

test('commit after rollback is a no-op rather than an error', async () => {
  const tx = await db.begin();
  await tx.rollback();
  await tx.commit();
});

test('exec runs raw SQL with no parameter translation', async () => {
  await db.run("INSERT INTO authors (full_name, search_full_name) VALUES (?, ?)", ['Exec Target', 'EXEC TARGET']);
  await db.exec("DELETE FROM authors WHERE full_name = 'Exec Target'");
  assert.equal(await db.get('SELECT 1 FROM authors WHERE full_name = ?', ['Exec Target']), undefined);
});

test('realBackend builds a pg-backed Backend without connecting', async () => {
  const { realBackend } = await import('../src/db/backend.js');
  const b = await realBackend();
  assert.equal(typeof b.query, 'function');
  assert.equal(typeof b.connect, 'function');
  assert.equal(typeof b.execScript, 'function');
  await b.end(); // closes the (never-connected) pool
});

test('initSchema is idempotent and safe to await twice', async () => {
  await initSchema();
  await initSchema();
  const genres = await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM genres');
  assert.ok(genres!.c > 0, 'the genre fixture was seeded');
});

test('updateCounters records one row per catalog total', async () => {
  await updateCounters();
  const rows = await db.all<{ name: string; value: number }>('SELECT name, value FROM counters');
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.value]));
  for (const key of ['allbooks', 'allcatalogs', 'allauthors', 'allgenres', 'allseries']) {
    assert.equal(typeof byName[key], 'number', `${key} was counted`);
  }
  assert.equal(byName.allbooks, 0);
  assert.ok(byName.allauthors >= 3);
});
