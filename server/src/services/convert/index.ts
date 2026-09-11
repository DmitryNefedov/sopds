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
  // Stryker disable next-line StringLiteral: Buffer.from(str, '') falls back to utf-8 anyway.
  return Buffer.from(irToFb2(ir), 'utf8');
}

// ---- external converter (Calibre) --------------------------------------

/** Locate `name` on PATH, returning the raw command output ("" / throw = absent). */
export function whichSync(name: string): string {
  // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: the Windows branch cannot be exercised on the CI platform; `which` is what matters here.
  const finder = process.platform === 'win32' ? 'where' : 'which';
  // Stryker disable next-line ObjectLiteral,ArrayDeclaration,StringLiteral: `stdio` only decides whether the child's stderr is muted; the captured stdout we return is unaffected.
  return execFileSync(finder, [name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

/**
 * Resolve `candidate` to an absolute converter path, or null when it cannot be
 * found. A candidate with a slash is taken as a literal path and only has to
 * exist; a bare name is looked up on PATH with which/where.
 */
export function probeConverter(
  candidate: string | null | undefined,
  deps: {
    existsSync?: (p: string) => boolean;
    lookup?: (name: string) => string;
  } = {},
): string | null {
  if (!candidate) return null;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const lookup = deps.lookup ?? whichSync;
  try {
    if (candidate.includes('/')) {
      return existsSync(candidate) ? candidate : null;
    }
    const found = lookup(candidate).trim().split('\n')[0];
    return found ? found : null;
  } catch {
    return null;
  }
}

let _externalPath: string | null | undefined;

/** Forget the probed converter path so the next call re-probes. */
export function refreshConverter(): void {
  _externalPath = undefined;
}

/** Settings listener: re-probe whenever the `ebookConvert` setting is touched. */
export function onSettingsPatch(patch: Partial<{ ebookConvert: string }>): void {
  if ('ebookConvert' in patch) refreshConverter();
}
// Stryker disable next-line CallExpression: module-wiring; the handler itself is covered by onSettingsPatch tests.
onChange(onSettingsPatch);

function externalConverter(): string | null {
  if (_externalPath !== undefined) return _externalPath;
  _externalPath = probeConverter(S.ebookConvert);
  return _externalPath;
}

export interface ConverterInfo {
  formats: readonly string[];
  external: string | null;
  engine: 'calibre' | 'builtin';
}

export function converterInfo(): ConverterInfo {
  const external = externalConverter();
  return {
    formats: CONVERTIBLE,
    external,
    engine: external ? 'calibre' : 'builtin',
  };
}

const execFileAsync = promisify(execFile);
export type ExecFileAsync = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
) => Promise<unknown>;

/**
 * Run the external converter on `buf`, going through a scratch directory it
 * always cleans up. Returns the output bytes, or throws when the converter
 * itself fails; a missing output file surfaces as an ENOENT the caller treats
 * like any other external failure.
 */
export async function runExternal(
  bin: string,
  buf: Buffer,
  from: string,
  to: string,
  exec: ExecFileAsync = execFileAsync,
): Promise<Buffer> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sopds-conv-'));
  const inFile = path.join(dir, `in.${from}`);
  const outFile = path.join(dir, `out.${to}`);
  try {
    await fs.promises.writeFile(inFile, buf);
    try {
      await exec(bin, [inFile, outFile], { timeout: 120000, maxBuffer: 4 << 20 });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(`ebook-convert failed: ${(e.stderr || e.message || '').slice(0, 500)}`);
    }
    return await fs.promises.readFile(outFile);
  } finally {
    // Stryker disable next-line ArrowFunction: removing the scratch dir is best-effort cleanup.
    await fs.promises.rm(dir, { recursive: true }).catch(() => undefined);
  }
}

// Spawned asynchronously on purpose: Calibre takes seconds to tens of seconds
// per book, and `spawnSync` would stall every other request for all of it.
// Returns null when there is no external converter, throws when it fails.
export async function externalConvert(
  buf: Buffer,
  from: string,
  to: string,
): Promise<Buffer | null> {
  const bin = externalConverter();
  if (!bin) return null;
  return runExternal(bin, buf, from, to);
}

// ---- cache -----------------------------------------------------------

/** Stable cache filename stem for a conversion, or null when uncacheable. */
export function cacheKeyFor(
  cacheKey: string | undefined,
  from: string,
  to: string,
  len: number,
): string | null {
  if (!cacheKey) return null;
  return crypto.createHash('sha1').update(`${cacheKey}:${from}:${to}:${len}`).digest('hex');
}

function cachePath(dir: string, key: string, to: string): string {
  return path.join(dir, `${key}.${to}`);
}

// Stryker disable next-line ArrowFunction: shared no-op tail for best-effort fs work.
const swallow = (): null => null;

/** Read a previously cached conversion, or null when there is no usable cache entry. */
async function readCache(file: string | null): Promise<Buffer | null> {
  // Stryker disable next-line ConditionalExpression: readFile(null) would reject into the same null; the guard just skips a doomed syscall.
  if (!file) return null;
  return fs.promises.readFile(file).catch(swallow);
}

/** Best-effort write of a conversion result; a failure here is never fatal. */
async function writeCache(dir: string, file: string | null, out: Buffer): Promise<void> {
  if (!file) return;
  await fs.promises
    .mkdir(dir, { recursive: true })
    .then(() => fs.promises.writeFile(file, out))
    .catch(swallow);
}

// ---- public API -----------------------------------------------------

const isConvertible = (f: string): f is ConvertFormat =>
  (CONVERTIBLE as readonly string[]).includes(f);

export interface ConvertDeps {
  /** Override the external converter step (defaults to Calibre when present). */
  external?: (buf: Buffer, from: string, to: string) => Promise<Buffer | null>;
  /** Override the on-disk cache directory. */
  cacheDir?: string;
}

// Convert `buf` from one format to another, preferring Calibre when present.
// A `cacheKey` enables on-disk caching of the result.
export async function convert(
  buf: Buffer,
  from: string,
  to: string,
  cacheKey?: string,
  deps: ConvertDeps = {},
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

  const runExt = deps.external ?? externalConvert;
  const cacheDir = deps.cacheDir ?? config.convertCacheDir;

  const key = cacheKeyFor(cacheKey, from, to, buf.length);
  const cacheFile = key ? cachePath(cacheDir, key, to) : null;

  const cached = await readCache(cacheFile);
  if (cached) return cached;

  // A throwing external converter just means "fall back to the built-in one".
  // Stryker disable next-line ArrowFunction: the rejection value is discarded, null triggers the fallback below.
  let out: Buffer | null = await runExt(buf, from, to).catch(() => null);
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

  await writeCache(cacheDir, cacheFile, out);
  return out;
}

export class ConvertError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}
