#!/usr/bin/env node
// Per-module mutation-test driver.
//
//   node bin/mutate.mjs <module-key> [more keys...]
//   node bin/mutate.mjs all
//
// Each key maps to a source glob and the smallest set of test files that
// exercise it. Narrowing the test files keeps a run to seconds - every
// DB-backed test file starts its own in-process PostgreSQL (~4s).
import { spawnSync } from 'node:child_process';

const MODULES = {
  lang:        { mutate: 'src/utils/lang.ts',                 tests: 'test/lang.test.ts' },
  cron:        { mutate: 'src/utils/cron.ts',                 tests: 'test/cron.test.ts' },
  download:    { mutate: 'src/utils/download.ts',             tests: 'test/download.test.ts' },
  http:        { mutate: 'src/utils/http.ts',                 tests: 'test/download.test.ts,test/routes.test.ts' },
  config:      { mutate: 'src/config/index.ts,src/config/paths.ts', tests: 'test/config.test.ts' },
  formats:     { mutate: 'src/formats/*.ts',                  tests: 'test/formats.test.ts,test/cover.test.ts,test/head.test.ts,test/fb2-unit.test.ts,test/mobi-unit.test.ts,test/epub-unit.test.ts' },
  'formats-fb2':   { mutate: 'src/formats/fb2.ts',            tests: 'test/fb2-unit.test.ts,test/cover.test.ts,test/formats.test.ts' },
  'formats-epub':  { mutate: 'src/formats/epub.ts',           tests: 'test/epub-unit.test.ts,test/cover.test.ts,test/formats.test.ts' },
  'formats-mobi':  { mutate: 'src/formats/mobi.ts',           tests: 'test/mobi-unit.test.ts,test/cover.test.ts,test/formats.test.ts' },
  'formats-index': { mutate: 'src/formats/index.ts',          tests: 'test/formats-index.test.ts,test/formats.test.ts,test/cover.test.ts,test/head.test.ts' },
  convert:     { mutate: 'src/services/convert/*.ts',         tests: 'test/convert.test.ts' },
  connectors:  { mutate: 'src/connectors/*.ts',              tests: 'test/zip-unit.test.ts,test/bookfiles-unit.test.ts,test/head.test.ts' },
  'connectors-zip':  { mutate: 'src/connectors/zip.ts',       tests: 'test/zip-unit.test.ts,test/head.test.ts' },
  'connectors-bf':   { mutate: 'src/connectors/bookfiles.ts', tests: 'test/bookfiles-unit.test.ts,test/head.test.ts' },
  db:          { mutate: 'src/db/index.ts,src/db/backend.ts', tests: 'test/db.test.ts,test/db-unit.test.ts' },
  settings:    { mutate: 'src/services/settings.ts',          tests: 'test/settings.test.ts,test/settings-unit.test.ts' },
  catalog:     { mutate: 'src/services/catalog.ts',           tests: 'test/search.test.ts,test/browse.test.ts,test/head.test.ts' },
  engine:      { mutate: 'src/services/scanner/engine.ts',    tests: 'test/engine.test.ts,test/scan-concurrency.test.ts,test/formats.test.ts' },
  scanner:     { mutate: 'src/services/scanner/index.ts,src/services/scanner/schedule.ts', tests: 'test/scan.test.ts' },
  watch:       { mutate: 'src/services/scanner/watch.ts',     tests: 'test/watch.test.ts,test/watch-unit.test.ts' },
  routes:      { mutate: 'src/routes/*.ts,src/app.ts',        tests: 'test/routes.test.ts,test/admin-auth.test.ts,test/browse.test.ts,test/search.test.ts' },
};

const keys = process.argv.slice(2);
if (keys.length === 0) {
  console.error(`usage: node bin/mutate.mjs <${Object.keys(MODULES).join('|')}|all>`);
  process.exit(2);
}

const runs = keys[0] === 'all' ? Object.keys(MODULES) : keys;
let failed = 0;
for (const key of runs) {
  const mod = MODULES[key];
  if (!mod) { console.error(`unknown module: ${key}`); process.exit(2); }
  console.log(`\n=== mutating ${key} (${mod.mutate}) ===\n`);
  const res = spawnSync('npx', ['stryker', 'run'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      SOPDS_TEST_DB: 'mem',
      STRYKER_MUTATE: mod.mutate,
      STRYKER_TEST_FILES: mod.tests,
    },
  });
  if (res.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
