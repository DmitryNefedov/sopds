import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import config from '../../config/index.js';
import { S, onChange } from '../settings.js';
import { fb2ToIr, irToFb2 } from './fb2.js';
import { epubToIr, irToEpub } from './epub.js';
import { mobiToIr, irToMobi } from './mobi.js';
import type { Ir } from './ir.js';

export const CONVERTIBLE = ['fb2', 'epub', 'mobi'] as const;
export type ConvertFormat = (typeof CONVERTIBLE)[number];

const TO_IR: Record<ConvertFormat, (buf: Buffer) => Ir> = {
  fb2: fb2ToIr,
  epub: epubToIr,
  mobi: mobiToIr,
};
const FROM_IR: Record<ConvertFormat, (ir: Ir) => Buffer> = {
  fb2: irToFb2Buf,
  epub: irToEpub,
  mobi: irToMobi,
};

function irToFb2Buf(ir: Ir): Buffer {
  return Buffer.from(irToFb2(ir), 'utf8');
}

// ---- external converter (Calibre) --------------------------------------

let _externalPath: string | null | undefined;
onChange((patch) => {
  if ('ebookConvert' in patch) _externalPath = undefined; // re-probe next call
});
function externalConverter(): string | null {
  if (_externalPath !== undefined) return _externalPath;
  _externalPath = null;
  const candidate = S.ebookConvert;
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

export interface ConverterInfo {
  formats: readonly string[];
  external: string | null;
  engine: 'calibre' | 'builtin';
}

export function converterInfo(): ConverterInfo {
  return {
    formats: CONVERTIBLE,
    external: externalConverter() || null,
    engine: externalConverter() ? 'calibre' : 'builtin',
  };
}

const execFileAsync = promisify(execFile);

// Spawned asynchronously on purpose: Calibre takes seconds to tens of seconds
// per book, and `spawnSync` would stall every other request for all of it.
async function externalConvert(buf: Buffer, from: string, to: string): Promise<Buffer | null> {
  const bin = externalConverter();
  if (!bin) return null;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sopds-conv-'));
  const inFile = path.join(dir, `in.${from}`);
  const outFile = path.join(dir, `out.${to}`);
  try {
    await fs.promises.writeFile(inFile, buf);
    try {
      await execFileAsync(bin, [inFile, outFile], { timeout: 120000, maxBuffer: 4 << 20 });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(`ebook-convert failed: ${(e.stderr || e.message || '').slice(0, 500)}`);
    }
    // Missing output throws ENOENT, which the caller treats like any other
    // external failure: fall back to the built-in converters.
    return await fs.promises.readFile(outFile);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

// ---- cache -----------------------------------------------------------

function cachePath(key: string, to: string): string {
  fs.mkdirSync(config.convertCacheDir, { recursive: true });
  return path.join(config.convertCacheDir, `${key}.${to}`);
}

// ---- public API -----------------------------------------------------

const isConvertible = (f: string): f is ConvertFormat =>
  (CONVERTIBLE as readonly string[]).includes(f);

// Convert `buf` from one format to another, preferring Calibre when present.
// A `cacheKey` enables on-disk caching of the result.
export async function convert(
  buf: Buffer,
  from: string,
  to: string,
  cacheKey?: string,
): Promise<Buffer> {
  from = String(from || '').toLowerCase();
  to = String(to || '').toLowerCase();
  if (from === to) return buf;
  if (!isConvertible(to)) {
    throw new ConvertError(`Cannot convert to .${to}`, 400);
  }
  if (!isConvertible(from)) {
    throw new ConvertError(
      `Cannot convert from .${from} (only ${CONVERTIBLE.join('/')} are supported)`,
      415,
    );
  }

  const key = cacheKey
    ? crypto.createHash('sha1').update(`${cacheKey}:${from}:${to}:${buf.length}`).digest('hex')
    : null;
  if (key) {
    try {
      return await fs.promises.readFile(cachePath(key, to));
    } catch {
      /* not cached yet */
    }
  }

  let out: Buffer | null = null;
  try {
    out = await externalConvert(buf, from, to);
  } catch {
    out = null; // fall back to built-in
  }
  if (!out) {
    try {
      const ir = TO_IR[from](buf);
      out = FROM_IR[to](ir);
    } catch (err) {
      throw new ConvertError(
        `Conversion ${from}->${to} failed: ${(err as Error).message}`,
        422,
      );
    }
  }

  if (key && out) {
    try {
      await fs.promises.writeFile(cachePath(key, to), out);
    } catch {
      /* cache is best-effort */
    }
  }
  return out;
}

export class ConvertError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}
