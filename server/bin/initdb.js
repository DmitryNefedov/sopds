#!/usr/bin/env node
import { initSchema, updateCounters } from '../src/db.js';

initSchema();
updateCounters();
console.log('Database initialised.');
