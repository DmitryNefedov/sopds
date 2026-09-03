import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import config from './config.js';
import { initSchema, updateCounters } from './db.js';
import { S, loadSettings } from './settings.js';
import { startScheduler } from './scheduler.js';
import { startWatcher } from './watcher.js';
import apiRoutes from './routes/api.js';
import opdsRoutes from './routes/opds.js';
import adminRoutes from './routes/admin.js';
import { requestLogger, debugRouter } from './debug.js';
import { SERVER_ROOT } from './paths.js';

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

async function main(): Promise<void> {
  await initSchema();
  await loadSettings();
  await updateCounters();

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

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Optionally serve the built React app (useful for `npm start` without the
  // separate nginx "ui" container; in Docker the ui container serves it).
  const webDist = path.resolve(SERVER_ROOT, '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false }));
    app.get('*', (req, res, next) => {
      if (
        req.path.startsWith('/api') ||
        req.path.startsWith('/opds') ||
        req.path.startsWith('/debug')
      )
        return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  };
  app.use(errorHandler);

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
    console.log(
      `  database:        postgres ${config.db.url || `${config.db.host}:${config.db.port}/${config.db.database}`}`,
    );
    startScheduler();
    startWatcher();
    if (S.scanEnabled) console.log(`  scheduled scan:  ${S.scanCron}`);
    if (S.watchEnabled) console.log(`  watching:        ${S.rootLib}`);
  });
}

main().catch((err) => {
  console.error('failed to start SimpleOPDS:', err);
  process.exit(1);
});
