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

const mq = (q) => {
  try {
    return !!window.matchMedia && window.matchMedia(q).matches;
  } catch {
    return false;
  }
};

// The server sets <html data-eink="server"> when the request headers look
// like an e-ink reader (e.g. EinkBro's X-Requested-With). Most reliable.
export function serverSaysEink() {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-eink') === 'server'
  );
}

export function mediaSaysEink() {
  // (update: slow) is the spec-blessed e-ink signal; (monochrome) catches
  // grayscale panels that still report a fast-ish refresh.
  return mq('(update: slow)') || mq('(monochrome)');
}

// Fallback heuristic for e-ink Android browsers that spoof a generic UA and
// implement none of the update/monochrome features (old Chromium): a
// touch-only device with reduced motion that does NOT report a fast display.
export function heuristicSaysEink() {
  const oldChromium = /Chrome\/(\d{1,2}|10[0-4])\./.test(navigator.userAgent || '');
  return (
    mq('(prefers-reduced-motion: reduce)') &&
    mq('(hover: none)') &&
    mq('(pointer: coarse)') &&
    !mq('(update: fast)') &&
    oldChromium
  );
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

  const detected =
    serverSaysEink() || mediaSaysEink() || uaSaysEink() || heuristicSaysEink();
  return { eink: detected, detected };
}
