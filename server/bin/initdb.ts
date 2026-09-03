#!/usr/bin/env node
import db, { initSchema, updateCounters } from '../src/db.js';

await initSchema();
await updateCounters();
console.log('Database initialised.');
await db.end();
