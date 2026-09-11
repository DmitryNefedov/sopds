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

export const API_PREFIXES = ['/api', '/opds', '/debug'];

/** Path of the built web app (a sibling of the server dir); in Docker the
 *  separate "ui" container serves it instead, so this path simply won't exist. */
// Stryker disable next-line StringLiteral: the '..' hop is only observable when <repo>/web/dist exists as a real sibling, which no test or sandbox layout reproduces.
export const WEB_DIST = path.resolve(SERVER_ROOT, '..', 'web', 'dist');

export function createApp(webDist: string = WEB_DIST): Express {
  const app = express();
  app.use(compression());
  app.use(cors());
  // Stryker disable next-line StringLiteral,CallExpression: one-line access logging to stdout - no request or response behaviour rides on it.
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
      // Stryker disable next-line StringLiteral: any query that returns proves the pool is up; the SQL text is irrelevant.
      await db.query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: (err as Error).message });
    }
  });

  serveWebApp(app, webDist);

  app.use(errorHandler);
  return app;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Stryker disable next-line CallExpression: diagnostic logging of the unhandled error.
  console.error(err);
  res.status(500).json({ error: (err as Error).message });
};

/** Serve the built React app when it is present, so `npm start` alone works.
 *  In Docker the separate "ui" container serves it instead. */
export function serveWebApp(app: Express, webDist: string): void {
  if (!fs.existsSync(webDist)) return;
  // Stryker disable next-line ObjectLiteral: with or without `index`, `/` resolves to index.html - here via the static handler, otherwise via the SPA fallback right below.
  app.use(express.static(webDist, { index: false }));
  app.get('*', (req, res, next) => {
    if (API_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}
