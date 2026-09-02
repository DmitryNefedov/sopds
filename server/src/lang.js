// Language-group detection, ported from opds_catalog/models.py LangCodes.
const LANG_CODES = {
  1: 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЬЫЪЭЮЯабвгдеёжзийклмнопрстуфхцчшщьыъэюя',
  2: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  3: '0123456789',
};

export const LANG_MENU = {
  0: 'Show all',
  1: 'Cyrillic',
  2: 'Latin',
  3: 'Digits',
  9: 'Other symbols',
};

export function getLangCode(s) {
  if (!s || s.length === 0) return 9;
  const first = s[0];
  for (const k of Object.keys(LANG_CODES)) {
    if (LANG_CODES[k].includes(first)) return Number(k);
  }
  return 9;
}

// Uppercase normalisation used for the search_* columns.
export function normalize(s) {
  return (s || '').toUpperCase().trim();
}
