import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import config from './config.js';
import { initSchema, updateCounters } from './db.js';
import { S } from './settings.js';
import { startScheduler } from './scheduler.js';
import { startWatcher } from './watcher.js';
import apiRoutes from './routes/api.js';
import opdsRoutes from './routes/opds.js';
import adminRoutes from './routes/admin.js';
import { requestLogger, debugRouter } from './debug.js';
import { einkSignals } from './eink-detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

initSchema();
updateCounters();

const app = express();
app.use(compression());
app.use(cors());
app.use(morgan('tiny'));
app.use(express.json());
app.use(requestLogger);

app.use('/debug', debugRouter);
app.use('/api/admin', adminRoutes);
app.use('/api', apiRoutes);
app.use('/opds', opdsRoutes);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Serve the built React app if present.
const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  const indexPath = path.join(webDist, 'index.html');
  let indexHtml = fs.readFileSync(indexPath, 'utf8');
  fs.watchFile(indexPath, () => {
    try {
      indexHtml = fs.readFileSync(indexPath, 'utf8');
    } catch {
      /* keep the old copy */
    }
  });

  // When the request looks like an e-ink reader, stamp the served HTML so the
  // SPA starts in e-ink mode with no flash of the colour theme.
  const sendApp = (req, res) => {
    const sig = einkSignals(req);
    let html = indexHtml;
    if (sig.eink) {
      html = html.replace(/<html(\s|>)/i, '<html data-eink="server"$1');
      res.setHeader('X-Eink-Detected', sig.reasons.join('; ') || '1');
    }
    res.type('html').send(html);
  };

  app.use(express.static(webDist, { index: false }));
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/opds') ||
      req.path.startsWith('/debug')
    )
      return next();
    sendApp(req, res);
  });
}

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

app.listen(config.port, config.host, () => {
  const bindsAll = config.host === '0.0.0.0' || config.host === '::';
  console.log(`SimpleOPDS listening on ${config.host}:${config.port}`);
  console.log(`  local:   http://localhost:${config.port}`);
  if (bindsAll) {
    for (const ip of lanAddresses()) {
      console.log(`  network: http://${ip}:${config.port}`);
    }
  }
  console.log(`  book collection: ${S.rootLib}`);
  console.log(`  database:        ${config.dbPath}`);
  if (process.env.SOPDS_LOG_REQUESTS !== '0') {
    console.log(
      `  request logging: ON — open  /debug  on the device to capture its browser details`,
    );
  }
  startScheduler();
  startWatcher();
  if (S.scanEnabled) console.log(`  scheduled scan:  ${S.scanCron}`);
  if (S.watchEnabled) console.log(`  watching:        ${S.rootLib}`);
});
