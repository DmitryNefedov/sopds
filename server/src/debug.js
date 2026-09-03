import { Router } from 'express';
import { einkSignals } from './eink-detect.js';

// Verbose request logging + a self-reporting client-inspection page, used to
// work out how to detect a particular device (e-ink readers etc.).
//
// Enabled by default; set SOPDS_LOG_REQUESTS=0 to quiet it down to the normal
// one-line logs.

const VERBOSE = process.env.SOPDS_LOG_REQUESTS !== '0';

function isNavigation(req) {
  if (req.path.startsWith('/api') || req.path.startsWith('/opds')) return false;
  if (req.get('sec-fetch-dest') === 'document') return true;
  const accept = req.get('accept') || '';
  if (accept.includes('text/html')) return true;
  // extensionless path that isn't an asset
  return !/\.[a-z0-9]+$/i.test(req.path);
}

export function requestLogger(req, res, next) {
  if (!VERBOSE || !isNavigation(req)) return next();

  const started = Date.now();
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    '?';

  res.on('finish', () => {
    const lines = [];
    lines.push('');
    lines.push('══════════ UI request ══════════════════════════════════════');
    lines.push(
      `${new Date().toISOString()}  ${req.method} ${req.originalUrl}  ->  ${res.statusCode}  (${Date.now() - started}ms)`,
    );
    lines.push(`remote: ${ip}   http/${req.httpVersion}`);
    lines.push('headers:');
    const keys = Object.keys(req.headers).sort();
    for (const k of keys) lines.push(`  ${k}: ${req.headers[k]}`);
    lines.push('════════════════════════════════════════════════════════════');
    console.log(lines.join('\n'));
  });

  next();
}

export const debugRouter = Router();

// Machine-readable view of what the server sees.
debugRouter.get('/headers', (req, res) => {
  res.json({
    time: new Date().toISOString(),
    method: req.method,
    httpVersion: req.httpVersion,
    remoteAddress: req.socket.remoteAddress,
    url: req.originalUrl,
    headers: req.headers,
    einkDetected: einkSignals(req),
  });
});

// The client posts back what its browser reports; log it prominently.
debugRouter.post('/report', (req, res) => {
  console.log('');
  console.log('╔═══════ CLIENT SELF-REPORT ═════════════════════════════════');
  console.log(JSON.stringify(req.body, null, 2));
  console.log('║  request headers for the same client:');
  console.log(JSON.stringify(req.headers, null, 2));
  console.log('║  server e-ink detection:', JSON.stringify(einkSignals(req)));
  console.log('╚═══════════════════════════════════════════════════════════');
  res.json({ ok: true, einkDetected: einkSignals(req) });
});

// Human-friendly page: open http://<server>:<port>/debug on the device.
debugRouter.get('/', (req, res) => {
  res.type('html').send(DEBUG_PAGE);
});

const DEBUG_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SimpleOPDS — device check</title>
<style>
  :root { color-scheme: light; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; background:#fff; color:#000; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 16px; }
  pre { white-space: pre-wrap; word-break: break-word; border: 2px solid #000; padding: 12px; font-size: 14px; }
  .ok { font-weight: 700; }
  button { font: inherit; padding: 10px 16px; border: 2px solid #000; background:#fff; }
</style>
</head><body>
<h1>SimpleOPDS device check</h1>
<p class="sub">This reports what your browser exposes. It has been sent to the server log too.</p>
<pre id="out">collecting…</pre>
<button id="copy">Copy to clipboard</button>
<script>
(function () {
  var out = document.getElementById('out');
  function mq(q) { try { return window.matchMedia(q).matches; } catch (e) { return 'ERR:' + e.message; } }

  var report = {
    href: location.href,
    userAgent: navigator.userAgent,
    appVersion: navigator.appVersion,
    vendor: navigator.vendor,
    platform: navigator.platform,
    product: navigator.product,
    languages: navigator.languages,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
    devicePixelRatio: window.devicePixelRatio,
    viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
    screen: {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
      orientation: screen.orientation && screen.orientation.type
    },
    media: {
      '(update: slow)': mq('(update: slow)'),
      '(update: fast)': mq('(update: fast)'),
      '(update: none)': mq('(update: none)'),
      '(monochrome)': mq('(monochrome)'),
      '(min-monochrome: 1)': mq('(min-monochrome: 1)'),
      '(color: 0)': mq('(color: 0)'),
      '(min-color: 1)': mq('(min-color: 1)'),
      '(dynamic-range: standard)': mq('(dynamic-range: standard)'),
      '(dynamic-range: high)': mq('(dynamic-range: high)'),
      '(inverted-colors: inverted)': mq('(inverted-colors: inverted)'),
      '(prefers-contrast: more)': mq('(prefers-contrast: more)'),
      '(prefers-color-scheme: dark)': mq('(prefers-color-scheme: dark)'),
      '(prefers-reduced-motion: reduce)': mq('(prefers-reduced-motion: reduce)'),
      '(pointer: coarse)': mq('(pointer: coarse)'),
      '(pointer: fine)': mq('(pointer: fine)'),
      '(hover: none)': mq('(hover: none)'),
      '(hover: hover)': mq('(hover: hover)')
    },
    userAgentData: null
  };

  function render() { out.textContent = JSON.stringify(report, null, 2); }
  render();

  function send() {
    try {
      fetch('/debug/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report)
      }).then(render, render);
    } catch (e) { /* ignore */ }
  }

  if (navigator.userAgentData) {
    report.userAgentData = {
      brands: navigator.userAgentData.brands,
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform
    };
    var want = ['model', 'platformVersion', 'fullVersionList', 'architecture', 'bitness'];
    if (navigator.userAgentData.getHighEntropyValues) {
      navigator.userAgentData.getHighEntropyValues(want).then(function (hev) {
        report.userAgentData.highEntropy = hev;
        render(); send();
      }, function () { send(); });
    } else { send(); }
  } else { send(); }

  document.getElementById('copy').addEventListener('click', function () {
    var t = out.textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(t);
    else {
      var r = document.createRange(); r.selectNode(out);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
      try { document.execCommand('copy'); } catch (e) {}
    }
  });
})();
</script>
</body></html>`;
