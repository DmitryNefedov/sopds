import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import config from '../config.js';
import { fb2ToIr, irToFb2 } from './fb2.js';
import { epubToIr, irToEpub } from './epub.js';
import { mobiToIr, irToMobi } from './mobi.js';

export const CONVERTIBLE = ['fb2', 'epub', 'mobi'];

const TO_IR = { fb2: fb2ToIr, epub: epubToIr, mobi: mobiToIr };
const FROM_IR = { fb2: irToFb2Buf, epub: irToEpub, mobi: irToMobi };

function irToFb2Buf(ir) {
  return Buffer.from(irToFb2(ir), 'utf8');
}

// ---- external converter (Calibre) --------------------------------------

let _externalPath;
function externalConverter() {
  if (_externalPath !== undefined) return _externalPath;
  _externalPath = null;
  const candidate = config.ebookConvert;
  if (!candidate) return _externalPath;
  try {
    if (candidate.includes('/')) {
      if (fs.existsSync(candidate)) _externalPath = candidate;
    } else {
      const found = execFileSync(
        process.platform === 'win32' ? 'where' : 'which',
        [candidate],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .toString()
        .trim()
        .split('\n')[0];
      if (found) _externalPath = found;
    }
  } catch {
    _externalPath = null;
  }
  return _externalPath;
}

export function converterInfo() {
  return {
    formats: CONVERTIBLE,
    external: externalConverter() || null,
    engine: externalConverter() ? 'calibre' : 'builtin',
  };
}

function externalConvert(buf, from, to) {
  const bin = externalConverter();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sopds-conv-'));
  const inFile = path.join(dir, `in.${from}`);
  const outFile = path.join(dir, `out.${to}`);
  try {
    fs.writeFileSync(inFile, buf);
    const res = spawnSync(bin, [inFile, outFile], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120000,
    });
    if (res.status !== 0 || !fs.existsSync(outFile)) {
      throw new Error(
        `ebook-convert failed: ${res.stderr ? res.stderr.toString().slice(0, 500) : res.status}`,
      );
    }
    return fs.readFileSync(outFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- cache -----------------------------------------------------------

function cachePath(key, to) {
  fs.mkdirSync(config.convertCacheDir, { recursive: true });
  return path.join(config.convertCacheDir, `${key}.${to}`);
}

// ---- public API -----------------------------------------------------

// Convert `buf` (a book in `from` format) to `to`. Returns a Buffer.
// `cacheKey` (optional) enables on-disk caching of the result.
export function convert(buf, from, to, cacheKey) {
  from = String(from || '').toLowerCase();
  to = String(to || '').toLowerCase();
  if (from === to) return buf;
  if (!CONVERTIBLE.includes(to)) {
    throw new ConvertError(`Cannot convert to .${to}`, 400);
  }
  if (!CONVERTIBLE.includes(from)) {
    throw new ConvertError(
      `Cannot convert from .${from} (only ${CONVERTIBLE.join('/')} are supported)`,
      415,
    );
  }

  const key = cacheKey
    ? crypto
        .createHash('sha1')
        .update(`${cacheKey}:${from}:${to}:${buf.length}`)
        .digest('hex')
    : null;
  if (key) {
    const p = cachePath(key, to);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }

  let out;
  try {
    out = externalConvert(buf, from, to);
  } catch (err) {
    out = null; // fall back to built-in
  }
  if (!out) {
    try {
      const ir = TO_IR[from](buf);
      out = FROM_IR[to](ir);
    } catch (err) {
      throw new ConvertError(
        `Conversion ${from}->${to} failed: ${err.message}`,
        422,
      );
    }
  }

  if (key && out) {
    try {
      fs.writeFileSync(cachePath(key, to), out);
    } catch {
      /* cache is best-effort */
    }
  }
  return out;
}

export class ConvertError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}
