import os from 'node:os';
import config from './config/index.js';
import { ensureSearchIndexes, initSchema, updateCounters } from './db/schema.js';
import { S, loadSettings } from './services/settings.js';
import { Scanner } from './services/scanner/index.js';
import { createApp } from './app.js';

// Process entry point: bring the database up, build the app, open the port and
// start the background work that must not block the healthcheck.

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

async function main(): Promise<void> {
  await initSchema();
  await loadSettings();
  await updateCounters();

  createApp().listen(config.port, config.host, () => {
    const bindsAll = config.host === '0.0.0.0' || config.host === '::';
    console.log(`SimpleOPDS listening on ${config.host}:${config.port}`);
    console.log(`  local:   http://localhost:${config.port}`);
    if (bindsAll) {
      for (const ip of lanAddresses()) {
        console.log(`  network: http://${ip}:${config.port}`);
      }
    }
    console.log(`  book collection: ${S.rootLib}`);
    console.log(
      `  database:        postgres ${config.db.url || `${config.db.host}:${config.db.port}/${config.db.database}`}`,
    );
    Scanner.start();
    // Built after the port is open: on a large catalog this takes minutes, and
    // searches work throughout, just more slowly until it finishes.
    void ensureSearchIndexes();
    if (S.scanEnabled) console.log(`  scheduled scan:  ${S.scanCron}`);
    if (S.watchEnabled) console.log(`  watching:        ${S.rootLib}`);
  });
}

main().catch((err) => {
  console.error('failed to start SimpleOPDS:', err);
  process.exit(1);
});
