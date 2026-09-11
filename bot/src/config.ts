// Env-derived bot config. Kept tiny and separate from the server's config: the
// bot is a standalone client and knows nothing about the server's internals,
// only its HTTP surface (see CONTEXT.md "Telegram bot").

export interface BotConfig {
  /** Telegram Bot API token, from @BotFather. */
  token: string;
  /** Base URL of the SOPDS catalog API the bot talks to, e.g. http://api:8000. */
  apiUrl: string;
  /** Telegram numeric user ids allowed to use the bot — anywhere they send
   *  from, private chat or group. `null` means unrestricted. */
  allowedUsers: Set<number> | null;
  /** Telegram numeric chat ids (groups/supergroups are negative) allowed to
   *  use the bot regardless of which member sent the message. `null` means
   *  unrestricted.
   *
   *  Kept apart from `allowedUsers` rather than folded into one list: a group
   *  being allowed says nothing about which of its members should be able to
   *  message the bot one-on-one, and vice versa. Access is granted whenever
   *  either list matches (see `bot.ts`'s access-control middleware); both
   *  `null` — the default — is unrestricted, same as before this existed.
   *  This collection has no schema of its own to gate access with, so these
   *  two allowlists are the only access control the bot has. */
  allowedChats: Set<number> | null;
}

export class MissingTokenError extends Error {
  constructor() {
    super('TELEGRAM_BOT_TOKEN is not set');
  }
}

/**
 * Shared parser behind both `TELEGRAM_ALLOWED_USERS` and
 * `TELEGRAM_ALLOWED_CHATS`: comma/whitespace-separated numeric Telegram ids
 * (never @usernames — those can change; ids don't; group/supergroup chat ids
 * are negative, which this passes through unchanged). Unset, empty, or
 * entirely non-numeric all mean "no restriction", so a typo that produces no
 * usable ids fails open rather than silently locking everyone out.
 */
export function parseIdList(raw: string | undefined): Set<number> | null {
  const ids = (raw || '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  return ids.length ? new Set(ids) : null;
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
    allowedUsers: parseIdList(env.TELEGRAM_ALLOWED_USERS),
    allowedChats: parseIdList(env.TELEGRAM_ALLOWED_CHATS),
  };
}
