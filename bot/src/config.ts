// Env-derived bot config. Kept tiny and separate from the server's config: the
// bot is a standalone client and knows nothing about the server's internals,
// only its HTTP surface (see CONTEXT.md "Telegram bot").

export interface BotConfig {
  /** Telegram Bot API token, from @BotFather. */
  token: string;
  /** Base URL of the SOPDS catalog API the bot talks to, e.g. http://api:8000. */
  apiUrl: string;
}

export class MissingTokenError extends Error {
  constructor() {
    super('TELEGRAM_BOT_TOKEN is not set');
  }
}

/**
 * Build the runtime config from an environment. Defaults to `process.env`;
 * pass an explicit environment to exercise the fallbacks in isolation.
 */
export function buildConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const token = env.TELEGRAM_BOT_TOKEN || '';
  if (!token) throw new MissingTokenError();
  return {
    token,
    apiUrl: (env.SOPDS_API_URL || 'http://localhost:8000').replace(/\/+$/, ''),
  };
}
