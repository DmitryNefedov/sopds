import fs from 'node:fs';
import { Router } from 'express';
import { SETTING_DEFS, getAll, setMany, SettingsError } from '../services/settings.js';
import { Scanner } from '../services/scanner/index.js';
import { converterInfo } from '../services/convert/index.js';
import config from '../config/index.js';
import { qstr } from '../utils/http.js';

const router = Router();

// Optional shared-secret guard. When SOPDS_ADMIN_TOKEN is set, every admin
// request must send it as `X-Admin-Token` (or `?token=`).
const TOKEN = process.env.SOPDS_ADMIN_TOKEN || '';
router.use((req, res, next) => {
  if (!TOKEN) return next();
  const provided = req.get('x-admin-token') || qstr(req.query.token);
  if (provided === TOKEN) return next();
  res.status(401).json({ error: 'admin token required' });
});

const groupOrder: string[] = [];
for (const d of SETTING_DEFS) if (!groupOrder.includes(d.group)) groupOrder.push(d.group);

router.get('/settings', (_req, res) => {
  res.json({
    auth: Boolean(TOKEN),
    groups: groupOrder.map((group) => ({
      group,
      settings: SETTING_DEFS.filter((d) => d.group === group).map((d) => ({
        key: d.key,
        label: d.label,
        help: d.help || null,
        type: d.type,
        default: d.default,
        min: d.min ?? null,
        max: d.max ?? null,
      })),
    })),
    values: getAll(),
    converter: converterInfo(),
  });
});

router.put('/settings', async (req, res) => {
  try {
    const values = await setMany(req.body || {});
    res.json({ values, converter: converterInfo(), scan: Scanner.status() });
  } catch (err) {
    if (err instanceof SettingsError) {
      res.status(err.status).json({ error: err.message, fields: err.fields });
    } else {
      res.status(400).json({ error: (err as Error).message, fields: null });
    }
  }
});

// Validate that a directory exists / is readable (used by the UI as the user types).
router.get('/check-path', (req, res) => {
  const p = qstr(req.query.path);
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return res.json({ ok: false, reason: 'not a directory' });
    const count = fs.readdirSync(p).length;
    res.json({ ok: true, entries: count });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    res.json({ ok: false, reason: e.code === 'ENOENT' ? 'does not exist' : e.message });
  }
});

router.get('/scan', (_req, res) => res.json(Scanner.status()));

router.post('/scan', (_req, res) => {
  // A first scan of a large collection runs for a long time, so start it in the
  // background and let the client poll GET /admin/scan for progress.
  res.json(Scanner.trigger('manual'));
});

router.get('/info', (_req, res) => {
  res.json({
    port: config.port,
    database: config.db.url || `${config.db.host}:${config.db.port}/${config.db.database}`,
    convertCacheDir: config.convertCacheDir,
    node: process.version,
    scan: Scanner.status(),
  });
});

export default router;
