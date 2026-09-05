#!/usr/bin/env node
// Usage: node bin/scan.js [path-to-book-collection]
// The path (or SOPDS_ROOT_LIB) overrides the "Book collection directory"
// setting for this run only.
import db from '../src/db/index.js';
import { initSchema } from '../src/db/schema.js';
import { setOverride, loadSettings, S } from '../src/services/settings.js';
import { runOnce } from '../src/services/scanner/engine.js';

if (process.argv[2]) setOverride('rootLib', process.argv[2]);

await initSchema();
await loadSettings();

console.log(`Scanning ${S.rootLib} ...`);
await runOnce({ log: console.log });
await db.end();
