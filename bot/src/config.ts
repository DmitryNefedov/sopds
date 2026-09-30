// Env-derived bot config: the bot is a standalone client, so it only knows
// the server's HTTP surface, never its internals (see CONTEXT.md "Telegram bot").

export interface BotConfig {
  /** Telegram Bot API token, from @BotFather. */
  token: string;
  /** Base URL of the SOPDS catalog API the bot talks to, e.g. http://api:8000. */
  apiUrl: string;
  /** Telegram numeric user ids allowed to use the bot — anywhere they send
   *  from, private chat or group. `null` means unrestricted. */
  allowedUsers: Set<number> | null;
  /** Telegram chat ids (groups are negative) allowed regardless of sender.
   *  `null` means unrestricted; access is granted when either list matches. */
  allowedChats: Set<number> | null;
}

export class MissingTokenError extends Error {
  constructor() {
    super('TELEGRAM_BOT_TOKEN is not set');
  }
}

/** Comma/whitespace-separated Telegram numeric ids (never @usernames).
 *  Unset or unparseable means unrestricted, not locked out. */
export function parseIdList(raw: string | undefined): Set<number> | null {
  const ids = (raw || '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  return ids.length ? new Set(ids) : null;
}

/** Builds config from `env` (defaults to `process.env`; overridable for tests). */
export function buildConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const token = env.TELEGRAM_BOT_TOKEN || '';
  if (!token) throw new MissingTokenError();
  return {
    token,
    apiUrl: (env.SOPDS_API_URL || 'http://localhost:8000').replace(/\/+$/, ''),
    allowedUsers: parseIdList(env.TELEGRAM_ALLOWED_USERS),
    allowedChats: parseIdList(env.TELEGRAM_ALLOWED_CHATS),
  };
}
