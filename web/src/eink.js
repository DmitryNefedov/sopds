// Detect e-ink / e-paper devices (Lenovo Smart Paper, Onyx Boox, Kindle,
// Kobo, reMarkable, PocketBook, Dasung, Bigme, Hisense ink phones, …).
//
// Priority:
//   1. explicit override  ?eink=1 / ?eink=0  or the stored preference
//   2. CSS Media Queries L4 hints: (update: slow) and (monochrome)
//   3. user-agent markers

const STORAGE_KEY = 'sopds-eink';

const UA_MARKERS =
  /\b(e-?ink|eink|epaper|e-?paper)\b|onyx|boox|remarkable|dasung|meebme|meebook|bigme|pocketbook|\bkobo\b|kindle|silk|hisense.*(a5|a7|a9)|lenovo.*(smart\s?paper|tb[0-9]{3,}|zac[0-9])/i;

export function mediaSaysEink() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    // (update: slow) is the spec-blessed e-ink signal; (monochrome) catches
    // grayscale panels that still report a fast-ish refresh.
    return (
      window.matchMedia('(update: slow)').matches ||
      window.matchMedia('(monochrome)').matches
    );
  } catch {
    return false;
  }
}

export function uaSaysEink() {
  if (typeof navigator === 'undefined') return false;
  return UA_MARKERS.test(navigator.userAgent || '');
}

export function storedEinkPref() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

export function setEinkPref(value) {
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

// Resolve the initial e-ink state and whether it was auto-detected.
export function resolveEink() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('eink')) {
    const forced = params.get('eink') !== '0';
    setEinkPref(forced);
    return { eink: forced, detected: false };
  }
  const stored = storedEinkPref();
  if (stored !== null) return { eink: stored, detected: false };

  const detected = mediaSaysEink() || uaSaysEink();
  return { eink: detected, detected };
}
