// Decide whether to render the e-ink UI (Lenovo Smart Paper, Onyx Boox,
// Kindle/Kobo browsers, …).
//
// There is no single reliable signal — some e-ink browsers spoof a normal
// User-Agent and report a "fast colour display" for every media query. So:
//   1. explicit override:  ?eink=1 / ?eink=0  or the saved preference
//   2. confident auto-detect: server hint, (update: slow)/(monochrome),
//      UA markers, or a strict heuristic  -> switch automatically
//   3. soft signals (reduced motion + touch-only + tablet-ish screen)
//      -> just *suggest* it with a dismissible prompt

const STORAGE_KEY = 'sopds-eink';
const SUGGEST_DISMISS_KEY = 'sopds-eink-suggest-dismissed';

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

export function prefersReducedMotion() {
  return mq('(prefers-reduced-motion: reduce)');
}

export function mediaSaysEink() {
  // (update: slow) is the spec-blessed e-ink signal; (monochrome) catches
  // grayscale panels that still report a fast-ish refresh.
  return mq('(update: slow)') || mq('(monochrome)');
}

export function uaSaysEink() {
  return UA_MARKERS.test((navigator && navigator.userAgent) || '');
}

// Touch-only device, no hover, animations already suppressed system-wide,
// and a screen the shape/size of an e-reader rather than a phone.
function softEinkSignals() {
  const w = window.screen ? window.screen.width : window.innerWidth;
  const h = window.screen ? window.screen.height : window.innerHeight;
  const short = Math.min(w, h);
  const ratio = short / Math.max(w, h);
  const tabletShaped = short >= 600 && ratio >= 0.6; // ~3:4..1:1, not a phone
  return (
    prefersReducedMotion() &&
    mq('(hover: none)') &&
    mq('(pointer: coarse)') &&
    tabletShaped
  );
}

// Confident enough to switch without asking: old-Chromium e-ink browsers that
// report nothing useful, on touch-only hardware with motion suppressed.
export function heuristicSaysEink() {
  const oldChromium = /Chrome\/(\d{1,2}|10[0-4])\./.test(
    (navigator && navigator.userAgent) || '',
  );
  return oldChromium && !mq('(update: fast)') && softEinkSignals();
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

export function suggestionDismissed() {
  try {
    return localStorage.getItem(SUGGEST_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}
export function dismissSuggestion() {
  try {
    localStorage.setItem(SUGGEST_DISMISS_KEY, '1');
  } catch {
    /* ignore */
  }
}

// Resolve the initial e-ink state, whether it was auto-detected, and whether
// we should offer a "switch to e-ink?" prompt.
export function resolveEink() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('eink')) {
    const forced = params.get('eink') !== '0';
    setEinkPref(forced);
    return { eink: forced, detected: false, suggest: false };
  }
  const stored = storedEinkPref();
  if (stored !== null) return { eink: stored, detected: false, suggest: false };

  const detected =
    serverSaysEink() || mediaSaysEink() || uaSaysEink() || heuristicSaysEink();
  if (detected) return { eink: true, detected: true, suggest: false };

  // ?einksuggest=1 forces the prompt (for testing / support).
  const suggest =
    (params.get('einksuggest') === '1' ||
      (softEinkSignals() && !suggestionDismissed()));
  return { eink: false, detected: false, suggest };
}
