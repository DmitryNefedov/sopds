import fs from 'node:fs';
import { Router } from 'express';
import { SETTING_DEFS, getAll, setMany } from '../settings.js';
import { runScan, scanState } from '../scheduler.js';
import { watcherState } from '../watcher.js';
import { converterInfo } from '../convert/index.js';
import config from '../config.js';

const fullScanState = () => ({ ...scanState(), watch: watcherState() });

const router = Router();

// Optional shared-secret guard. When SOPDS_ADMIN_TOKEN is set, every admin
// request must send it as `X-Admin-Token` (or `?token=`).
const TOKEN = process.env.SOPDS_ADMIN_TOKEN || '';
router.use((req, res, next) => {
  if (!TOKEN) return next();
  const provided = req.get('x-admin-token') || req.query.token;
  if (provided === TOKEN) return next();
  res.status(401).json({ error: 'admin token required' });
});

const groupOrder = [];
for (const d of SETTING_DEFS) if (!groupOrder.includes(d.group)) groupOrder.push(d.group);

router.get('/settings', (req, res) => {
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

router.put('/settings', (req, res) => {
  try {
    const values = setMany(req.body || {});
    res.json({ values, converter: converterInfo(), scan: fullScanState() });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, fields: err.fields || null });
  }
});

// Validate that a directory exists / is readable (used by the UI as the user types).
router.get('/check-path', (req, res) => {
  const p = String(req.query.path || '');
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return res.json({ ok: false, reason: 'not a directory' });
    const count = fs.readdirSync(p).length;
    res.json({ ok: true, entries: count });
  } catch (err) {
    res.json({ ok: false, reason: err.code === 'ENOENT' ? 'does not exist' : err.message });
  }
});

router.get('/scan', (req, res) => res.json(fullScanState()));

router.post('/scan', async (req, res) => {
  const result = await runScan({ reason: 'manual' });
  res.json(result);
});

router.get('/info', (req, res) => {
  res.json({
    port: config.port,
    dbPath: config.dbPath,
    convertCacheDir: config.convertCacheDir,
    node: process.version,
    scan: fullScanState(),
  });
});

export default router;
