import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLangCode, normalize, LANG_MENU } from '../src/utils/lang.js';

// Script-group detection for the alphabet browse menu, and the uppercase
// normalisation shared by every search_* column.

test('getLangCode groups a title by the script of its first character', () => {
  assert.equal(getLangCode('Дозор'), 1, 'Cyrillic');
  assert.equal(getLangCode('ёлка'), 1, 'ё counts as Cyrillic');
  assert.equal(getLangCode('Watch'), 2, 'Latin');
  assert.equal(getLangCode('zebra'), 2, 'lower-case Latin');
  assert.equal(getLangCode('1984'), 3, 'Digits');
  assert.equal(getLangCode('0'), 3);
  assert.equal(getLangCode('—dash'), 9, 'punctuation is "other"');
  assert.equal(getLangCode('日本語'), 9, 'unhandled scripts are "other"');
});

test('getLangCode treats every empty-ish title as "other symbols"', () => {
  assert.equal(getLangCode(''), 9);
  assert.equal(getLangCode(null), 9);
  assert.equal(getLangCode(undefined), 9);
});

test('getLangCode only inspects the first character', () => {
  assert.equal(getLangCode('A1'), 2, 'Latin then digit -> Latin');
  assert.equal(getLangCode('1A'), 3, 'digit then Latin -> Digits');
  assert.equal(getLangCode(' A'), 9, 'leading space is "other"');
});

test('LANG_MENU is the exact label set the browse UI renders', () => {
  assert.deepEqual(LANG_MENU, {
    0: 'Show all',
    1: 'Cyrillic',
    2: 'Latin',
    3: 'Digits',
    9: 'Other symbols',
  });
});

test('normalize upper-cases and trims for the search_* columns', () => {
  assert.equal(normalize('  Night Watch '), 'NIGHT WATCH');
  assert.equal(normalize('дозор'), 'ДОЗОР');
  assert.equal(normalize('trailing '), 'TRAILING');
  assert.equal(normalize(' leading'), 'LEADING');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(''), '');
});
