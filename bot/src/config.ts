// Env-derived bot config. Kept tiny and separate from the server's config: the
// bot is a standalone client and knows nothing about the server's internals,
// only its HTTP surface (see CONTEXT.md "Telegram bot").

export interface BotConfig {
  /** Telegram Bot API token, from @BotFather. */
  token: string;
  /** Base URL of the SOPDS catalog API the bot talks to, e.g. http://api:8000. */
  apiUrl: string;
  /** Telegram numeric user ids allowed to use the bot. `null` means
   *  unrestricted (the default) — this collection has no schema of its own to
   *  gate access with, so an explicit allowlist is the only access control
   *  the bot has. */
  allowedUsers: Set<number> | null;
}

export class MissingTokenError extends Error {
  constructor() {
    super('TELEGRAM_BOT_TOKEN is not set');
  }
}

/** `TELEGRAM_ALLOWED_USERS` is comma/whitespace-separated numeric Telegram
 *  user ids (not @usernames — those can change; ids don't). Unset, empty, or
 *  entirely non-numeric all mean "no restriction", so a typo that produces no
 *  usable ids fails open rather than silently locking everyone out. */
export function parseAllowedUsers(raw: string | undefined): Set<number> | null {
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
    allowedUsers: parseAllowedUsers(env.TELEGRAM_ALLOWED_USERS),
  };
}
