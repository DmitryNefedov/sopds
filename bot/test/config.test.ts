import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, parseIdList, MissingTokenError } from '../src/config.js';

test('buildConfig throws MissingTokenError when TELEGRAM_BOT_TOKEN is unset', () => {
  assert.throws(() => buildConfig({}), MissingTokenError);
});

test('buildConfig defaults apiUrl and leaves both allowlists unrestricted', () => {
  const config = buildConfig({ TELEGRAM_BOT_TOKEN: 't' });
  assert.equal(config.token, 't');
  assert.equal(config.apiUrl, 'http://localhost:8000');
  assert.equal(config.allowedUsers, null);
  assert.equal(config.allowedChats, null);
});

test('buildConfig strips a trailing slash from SOPDS_API_URL', () => {
  const config = buildConfig({ TELEGRAM_BOT_TOKEN: 't', SOPDS_API_URL: 'http://api:8000/' });
  assert.equal(config.apiUrl, 'http://api:8000');
});

test('parseIdList accepts comma and/or whitespace separated ids', () => {
  assert.deepEqual(parseIdList('1,2, 3   4'), new Set([1, 2, 3, 4]));
});

test('parseIdList keeps negative ids (group/supergroup chat ids are negative)', () => {
  assert.deepEqual(parseIdList('-1001234567890,42'), new Set([-1001234567890, 42]));
});

test('parseIdList treats unset, empty, or all-non-numeric input as unrestricted (fails open)', () => {
  for (const raw of [undefined, '', '   ', 'alice,bob']) {
    assert.equal(parseIdList(raw), null, JSON.stringify(raw));
  }
});

test('parseIdList drops non-numeric entries but keeps the numeric ones', () => {
  assert.deepEqual(parseIdList('1,alice,2'), new Set([1, 2]));
});

test('buildConfig wires TELEGRAM_ALLOWED_USERS and TELEGRAM_ALLOWED_CHATS through independently', () => {
  const config = buildConfig({
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_ALLOWED_USERS: '111,222',
    TELEGRAM_ALLOWED_CHATS: '-100999',
  });
  assert.deepEqual(config.allowedUsers, new Set([111, 222]));
  assert.deepEqual(config.allowedChats, new Set([-100999]));
});
