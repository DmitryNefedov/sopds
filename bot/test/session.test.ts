import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  getSession,
  setPage,
  clearAllSessions,
  sessionCount,
  MAX_SESSIONS,
  SESSION_TTL_MS,
} from '../src/search/session.js';

test.beforeEach(() => clearAllSessions());

test('createSession mints a token that getSession resolves back to the same query/mode', () => {
  const { token, session } = createSession('hobbit', 'prefix');
  assert.equal(session.query, 'hobbit');
  assert.equal(session.mode, 'prefix');
  assert.equal(session.page, 1);
  assert.deepEqual(getSession(token), session);
});

test('two sessions get distinct tokens', () => {
  const a = createSession('a', 'prefix').token;
  const b = createSession('b', 'prefix').token;
  assert.notEqual(a, b);
});

test('getSession returns null for an unknown token — reported as expired, not guessed at', () => {
  assert.equal(getSession('does-not-exist'), null);
});

test('setPage advances the cursor a later getSession sees', () => {
  const { token } = createSession('q', 'prefix');
  setPage(token, 3);
  assert.equal(getSession(token)!.page, 3);
});

test('setPage on an unknown token is a silent no-op', () => {
  assert.doesNotThrow(() => setPage('nope', 5));
});

test('a session past the idle TTL is gone: getSession reports it as expired', (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { token } = createSession('q', 'prefix');
  t.mock.method(Date, 'now', () => now + SESSION_TTL_MS + 1);
  assert.equal(getSession(token), null);
});

test('getSession refreshes touchedAt, so an actively-paged session outlives the idle TTL', (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { token } = createSession('q', 'prefix');

  // Poll just under the TTL repeatedly - each poll should keep it alive.
  let clock = now;
  for (let i = 0; i < 3; i++) {
    clock += SESSION_TTL_MS - 1000;
    t.mock.method(Date, 'now', () => clock);
    assert.notEqual(getSession(token), null, `still alive at step ${i}`);
  }
});

test('cache-shaped: creating past MAX_SESSIONS evicts the oldest rather than growing without bound', () => {
  const tokens: string[] = [];
  for (let i = 0; i < MAX_SESSIONS; i++) tokens.push(createSession(`q${i}`, 'prefix').token);
  assert.equal(sessionCount(), MAX_SESSIONS);

  createSession('one-more', 'prefix');
  assert.equal(sessionCount(), MAX_SESSIONS, 'stays bounded');
  assert.equal(getSession(tokens[0]), null, 'the oldest session was evicted');
});

test('clearAllSessions drops everything, simulating a restart', () => {
  createSession('q', 'prefix');
  clearAllSessions();
  assert.equal(sessionCount(), 0);
});
