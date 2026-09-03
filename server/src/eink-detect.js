// Server-side "is this an e-ink device" guess, from request headers.
//
// e-ink Android browsers (EinkBro, Onyx's browser, …) tend to send a generic
// desktop-ish User-Agent and report nothing useful for (update: slow) /
// (monochrome). The reliable tell is the WebView's `X-Requested-With` package
// name, backed up by a UA check for the readers that do identify themselves.

// Known e-ink browser / launcher package names (X-Requested-With), plus a
// catch-all for anything mentioning e-ink / e-paper.
const EINK_XRW =
  /einkbro|\beink\b|e-?ink|e-?paper|epaper|onyx|boox|meebook|bigme|dasung|readera\.premium\.eink/i;

// e-ink readers whose User-Agent identifies them.
const EINK_UA =
  /\b(e-?ink|eink|e-?paper|epaper)\b|onyx|boox|remarkable|dasung|pocketbook|\bkobo\b|kindle|silk|meebook|bigme|hisense.*(a5|a7|a9)|lenovo.*(smart ?paper|tb[0-9]{3,}|zac[0-9])/i;

export function einkSignals(req) {
  const xrw = req.get('x-requested-with') || '';
  const ua = req.get('user-agent') || '';
  const byXrw = EINK_XRW.test(xrw);
  const byUa = EINK_UA.test(ua);
  return {
    eink: byXrw || byUa,
    reasons: [byXrw && `x-requested-with=${xrw}`, byUa && 'user-agent'].filter(Boolean),
  };
}

export function isEinkRequest(req) {
  return einkSignals(req).eink;
}

// Browsers that can't run the React SPA and should get the server-rendered
// /lite catalog: the Kindle "experimental browser" (frozen ancient UA),
// old Kobo/NOOK/Sony readers, feature-phone browsers, pre-Chromium engines.
const LITE_UA =
  /\bkindle\b|\bnook\b|kobo touch|sony.*reader|netfront|obigo|\bucweb\b|\bMIDP\b|\bSymbian\b/i;

export function wantsLiteUi(req) {
  const cookie = req.get('cookie') || '';
  if (req.query.lite === '0' || /(?:^|;\s*)lite=0/.test(cookie)) return false;
  if (req.query.lite === '1' || /(?:^|;\s*)lite=1/.test(cookie)) return true;

  const ua = req.get('user-agent') || '';
  if (LITE_UA.test(ua)) return true;
  if (/Chrome\/\d/.test(ua)) return false; // any modern Chromium is fine
  const wk = ua.match(/AppleWebKit\/(\d+)/);
  if (wk && Number(wk[1]) < 534) return true; // pre-2011 Safari/WebKit
  if (/MSIE [1-9]\./.test(ua) || /Trident\/[1-4]\./.test(ua)) return true;
  return false;
}
