import { buildConfig } from './config.js';
import { CatalogClient } from './catalog/api-client.js';
import { createBot } from './telegram/bot.js';

// Process entry point: long-polls the Telegram Bot API. No port to open, no
// database to reach — the catalog API is the only thing this depends on.

function main(): void {
  const config = buildConfig();
  const api = new CatalogClient({ baseUrl: config.apiUrl });
  const bot = createBot(config, api);

  bot.catch((err) => {
    console.error('sopds-bot error:', err);
  });

  bot.start({
    onStart: () => {
      console.log(`sopds-bot polling; catalog API at ${config.apiUrl}`);
    },
  });
}

main();
