import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate, coerce } from '../src/db/index.js';
import { poolConfig, bigintAsNumber } from '../src/db/backend.js';

// The placeholder rewriter and the parameter coercions - pure, no database.

test('translate leaves a bare statement and empty/absent params alone', () => {
  assert.deepEqual(translate('SELECT 1', undefined), { text: 'SELECT 1', values: [] });
  assert.deepEqual(translate('SELECT 1', null as never), { text: 'SELECT 1', values: [] });
  assert.deepEqual(translate('SELECT 1::int', undefined), { text: 'SELECT 1::int', values: [] });
  // The null-params short-circuit matters: without it the named-param branch
  // would dereference `params[name]` on undefined and throw.
  assert.deepEqual(translate('SELECT @a', undefined), { text: 'SELECT @a', values: [] });
});

test('translate numbers positional ? placeholders left to right', () => {
  assert.deepEqual(translate('SELECT ?, ?, ?', [10, 20, 30]), {
    text: 'SELECT $1, $2, $3',
    values: [10, 20, 30],
  });
});

test('translate coerces positional values as it binds them', () => {
  assert.deepEqual(translate('VALUES (?, ?, ?)', [true, false, undefined]), {
    text: 'VALUES ($1, $2, $3)',
    values: [1, 0, null],
  });
});

test('translate binds a repeated named parameter exactly once', () => {
  assert.deepEqual(translate('SELECT @n AS a, @n AS b, @m AS c', { n: 7, m: 9 }), {
    text: 'SELECT $1 AS a, $1 AS b, $2 AS c',
    values: [7, 9],
  });
});

test('translate accepts both @name and :name spellings', () => {
  assert.deepEqual(translate('SELECT @a, :b', { a: 1, b: 2 }), {
    text: 'SELECT $1, $2',
    values: [1, 2],
  });
});

test('translate does not treat a :: cast as a parameter', () => {
  assert.deepEqual(translate('SELECT @n::int AS a, val::text', { n: 5 }), {
    text: 'SELECT $1::int AS a, val::text',
    values: [5],
  });
});

test('translate coerces named values too', () => {
  assert.deepEqual(translate('SELECT @b, @u', { b: true, u: undefined }), {
    text: 'SELECT $1, $2',
    values: [1, null],
  });
});

test('translate returns named params in first-seen order, not object order', () => {
  assert.deepEqual(translate('SELECT @second, @first', { first: 'F', second: 'S' }), {
    text: 'SELECT $1, $2',
    values: ['S', 'F'],
  });
});

test('coerce maps undefined -> null and booleans -> 0/1, and passes the rest through', () => {
  assert.equal(coerce(undefined), null);
  assert.equal(coerce(true), 1);
  assert.equal(coerce(false), 0);
  assert.equal(coerce(null), null);
  assert.equal(coerce(0), 0);
  assert.equal(coerce(''), '');
  assert.equal(coerce('x'), 'x');
  assert.equal(coerce(42), 42);
  const d = new Date();
  assert.equal(coerce(d), d);
});

test('poolConfig prefers a connection string, else the discrete PG fields', () => {
  assert.deepEqual(poolConfig({ url: 'postgres://u:p@h/db', host: 'x', port: 1, user: 'x', password: 'x', database: 'x' }), {
    connectionString: 'postgres://u:p@h/db',
  });
  assert.deepEqual(poolConfig({ url: '', host: 'pg', port: 5433, user: 'alice', password: 'secret', database: 'lib' }), {
    host: 'pg',
    port: 5433,
    user: 'alice',
    password: 'secret',
    database: 'lib',
  });
});

test('bigintAsNumber parses a numeric string but preserves null', () => {
  assert.equal(bigintAsNumber('42'), 42);
  assert.equal(bigintAsNumber('9007199254740993'), 9007199254740993);
  assert.equal(bigintAsNumber(null), null);
  assert.equal(bigintAsNumber('0'), 0);
});
