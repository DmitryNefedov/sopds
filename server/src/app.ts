import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import type { Express, ErrorRequestHandler } from 'express';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import db from './db/index.js';
import apiRoutes from './routes/api.js';
import opdsRoutes from './routes/opds.js';
import adminRoutes from './routes/admin.js';
import { requestLogger, debugRouter } from './routes/debug.js';
import { SERVER_ROOT } from './config/paths.js';

// Assembles the Express application. Kept apart from `index.ts` so tests can
// mount the real routes without opening a port or starting the Scanner.

const API_PREFIXES = ['/api', '/opds', '/debug'];

export function createApp(): Express {
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

  // Liveness + DB readiness, used by the compose healthcheck. `/healthz` is
  // kept as an alias for existing callers.
  app.get(['/health', '/healthz'], async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: (err as Error).message });
    }
  });

  serveWebApp(app);

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  };
  app.use(errorHandler);
  return app;
}

/** Serve the built React app when it is present, so `npm start` alone works.
 *  In Docker the separate "ui" container serves it instead. */
function serveWebApp(app: Express): void {
  const webDist = path.resolve(SERVER_ROOT, '..', 'web', 'dist');
  if (!fs.existsSync(webDist)) return;
  app.use(express.static(webDist, { index: false }));
  app.get('*', (req, res, next) => {
    if (API_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}
