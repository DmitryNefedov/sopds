#!/usr/bin/env node
// Usage: node bin/scan.js [path-to-book-collection]
// or:    SOPDS_ROOT_LIB=/books npm run scan
import { initSchema } from '../src/db.js';
import { scan } from '../src/scanner.js';
import config from '../src/config.js';

if (process.argv[2]) config.rootLib = process.argv[2];

initSchema();
console.log(`Scanning ${config.rootLib} ...`);
scan({ log: console.log });
