import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findUp(name: string, from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, name))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

/**
 * The `server/` directory, resolved the same way whether the code runs from
 * `src/` (via tsx) or from the compiled `dist/` tree. Non-code assets
 * (`db/changelog/`, `genres.json`, `assets/`) are read relative to this.
 */
export const SERVER_ROOT = findUp(
  'package.json',
  path.dirname(fileURLToPath(import.meta.url)),
);
