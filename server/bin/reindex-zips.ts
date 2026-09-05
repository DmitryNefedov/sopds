#!/usr/bin/env node
// Backfill books.zip_offset / zip_csize / zip_method for a catalog scanned
// before the scan recorded them. Only central directories are read — nothing is
// inflated or re-parsed — and books keep working throughout, since a row with no
// location falls back to `connectors/bookfiles.ts` `readBookBytes` by name.
//
//   npm --workspace server run reindex
//   docker compose exec api node dist/bin/reindex-zips.js

import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db/index.js';
import { initSchema } from '../src/db/schema.js';
import type { SqlParam } from '../src/db/index.js';
import { loadSettings, get as setting } from '../src/services/settings.js';
import { zipLocations } from '../src/connectors/zip.js';

const CAT_ZIP = 1;
const ROWS_PER_STATEMENT = 1000;
const arr = (...values: unknown[][]): SqlParam[] => values as unknown as SqlParam[];

async function main(): Promise<void> {
  await initSchema();
  await loadSettings();
  const rootLib = setting('rootLib');

  const force = process.argv.includes('--all');
  const archives = await db.all<{ path: string; pending: number }>(
    `SELECT b.path, COUNT(*)::int AS pending
       FROM books b
      WHERE b.cat_type = ? ${force ? '' : 'AND b.zip_offset IS NULL'}
      GROUP BY b.path
      ORDER BY b.path`,
    [CAT_ZIP],
  );
  if (!archives.length) {
    console.log('Nothing to do: every archived book already knows where it lives.');
    await db.end();
    return;
  }

  const total = archives.reduce((n, a) => n + a.pending, 0);
  console.log(`${archives.length} archives, ${total} books to locate.`);

  const started = Date.now();
  let done = 0;
  let updated = 0;
  let missing = 0;
  let unreadable = 0;

  for (const { path: relZip } of archives) {
    const abs = path.join(rootLib, relZip);
    if (!fs.existsSync(abs)) {
      unreadable++;
      console.log(`  archive not found, skipped: ${relZip}`);
      continue;
    }
    let locations;
    try {
      locations = await zipLocations(abs);
    } catch (err) {
      unreadable++;
      console.log(`  bad archive ${relZip}: ${(err as Error).message}`);
      continue;
    }

    const rows = await db.all<{ filename: string }>(
      `SELECT filename FROM books WHERE path = ? ${force ? '' : 'AND zip_offset IS NULL'}`,
      [relZip],
    );
    const found = rows.filter((r) => locations.has(r.filename));
    missing += rows.length - found.length;

    for (let i = 0; i < found.length; i += ROWS_PER_STATEMENT) {
      const slice = found.slice(i, i + ROWS_PER_STATEMENT);
      const r = await db.run(
        `UPDATE books b SET zip_offset = u.off, zip_csize = u.csize, zip_method = u.method
           FROM UNNEST($2::text[], $3::bigint[], $4::bigint[], $5::int[])
                AS u(name, off, csize, method)
          WHERE b.path = $1 AND b.filename = u.name`,
        [
          relZip,
          ...arr(
            slice.map((x) => x.filename),
            slice.map((x) => locations.get(x.filename)!.offset),
            slice.map((x) => locations.get(x.filename)!.csize),
            slice.map((x) => locations.get(x.filename)!.method),
          ),
        ],
      );
      updated += r.rowCount;
    }

    if (++done % 25 === 0 || done === archives.length) {
      const secs = (Date.now() - started) / 1000;
      console.log(
        `  ${done}/${archives.length} archives, ${updated} books located (${secs.toFixed(0)}s)`,
      );
    }
  }

  console.log(
    `Done in ${((Date.now() - started) / 1000).toFixed(0)}s: ${updated} located` +
      (missing ? `, ${missing} no longer in their archive (a scan will clean those up)` : '') +
      (unreadable ? `, ${unreadable} archives unreadable` : ''),
  );
  await db.end();
}

main().catch((err) => {
  console.error('reindex failed:', err);
  process.exit(1);
});
