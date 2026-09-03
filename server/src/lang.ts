// Language-group detection, ported from opds_catalog/models.py LangCodes.
const LANG_CODES: Record<number, string> = {
  1: 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЬЫЪЭЮЯабвгдеёжзийклмнопрстуфхцчшщьыъэюя',
  2: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  3: '0123456789',
};

export const LANG_MENU: Record<number, string> = {
  0: 'Show all',
  1: 'Cyrillic',
  2: 'Latin',
  3: 'Digits',
  9: 'Other symbols',
};

export function getLangCode(s: string | null | undefined): number {
  if (!s || s.length === 0) return 9;
  const first = s[0];
  for (const k of Object.keys(LANG_CODES)) {
    if (LANG_CODES[Number(k)].includes(first)) return Number(k);
  }
  return 9;
}

// Uppercase normalisation used for the search_* columns.
export function normalize(s: string | null | undefined): string {
  return (s || '').toUpperCase().trim();
}
