#!/usr/bin/env node
// Usage: node bin/scan.js [path-to-book-collection]
// The path (or SOPDS_ROOT_LIB) overrides the "Book collection directory"
// setting for this run only.
import db, { initSchema } from '../src/db.js';
import { setOverride, loadSettings, S } from '../src/settings.js';
import { scan } from '../src/scanner.js';

if (process.argv[2]) setOverride('rootLib', process.argv[2]);

await initSchema();
await loadSettings();

console.log(`Scanning ${S.rootLib} ...`);
await scan({ log: console.log });
await db.end();
