import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, parseAllowedUsers, MissingTokenError } from '../src/config.js';

test('buildConfig throws MissingTokenError when TELEGRAM_BOT_TOKEN is unset', () => {
  assert.throws(() => buildConfig({}), MissingTokenError);
});

test('buildConfig defaults apiUrl and leaves allowedUsers unrestricted', () => {
  const config = buildConfig({ TELEGRAM_BOT_TOKEN: 't' });
  assert.equal(config.token, 't');
  assert.equal(config.apiUrl, 'http://localhost:8000');
  assert.equal(config.allowedUsers, null);
});

test('buildConfig strips a trailing slash from SOPDS_API_URL', () => {
  const config = buildConfig({ TELEGRAM_BOT_TOKEN: 't', SOPDS_API_URL: 'http://api:8000/' });
  assert.equal(config.apiUrl, 'http://api:8000');
});

test('parseAllowedUsers accepts comma and/or whitespace separated ids', () => {
  assert.deepEqual(parseAllowedUsers('1,2, 3   4'), new Set([1, 2, 3, 4]));
});

test('parseAllowedUsers treats unset, empty, or all-non-numeric input as unrestricted (fails open)', () => {
  for (const raw of [undefined, '', '   ', 'alice,bob']) {
    assert.equal(parseAllowedUsers(raw), null, JSON.stringify(raw));
  }
});

test('parseAllowedUsers drops non-numeric entries but keeps the numeric ones', () => {
  assert.deepEqual(parseAllowedUsers('1,alice,2'), new Set([1, 2]));
});

test('buildConfig wires TELEGRAM_ALLOWED_USERS through to allowedUsers', () => {
  const config = buildConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USERS: '111,222' });
  assert.deepEqual(config.allowedUsers, new Set([111, 222]));
});
