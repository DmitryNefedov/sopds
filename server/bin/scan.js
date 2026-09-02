#!/usr/bin/env node
// Usage: node bin/scan.js [path-to-book-collection]
// The path (or SOPDS_ROOT_LIB) overrides the "Book collection directory"
// setting for this run only.
import { setOverride } from '../src/settings.js';
import { scan } from '../src/scanner.js';
import { S } from '../src/settings.js';

if (process.argv[2]) setOverride('rootLib', process.argv[2]);

console.log(`Scanning ${S.rootLib} ...`);
scan({ log: console.log });
