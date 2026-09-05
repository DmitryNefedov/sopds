#!/usr/bin/env node
import db from '../src/db/index.js';
import { initSchema, updateCounters } from '../src/db/schema.js';

await initSchema();
await updateCounters();
console.log('Database initialised.');
await db.end();
