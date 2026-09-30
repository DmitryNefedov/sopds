// Search session: a Title prefix search plus its page cursor, addressed by an
// opaque token. Cache-shaped, not durable — see CONTEXT.md.

export type SearchMode = 'prefix' | 'anywhere';

export interface SearchSession {
  query: string;
  mode: SearchMode;
  /** The last page this session has served; `more` asks for `page + 1`. */
  page: number;
  createdAt: number;
  touchedAt: number;
}

/** Idle sessions older than this are swept out; picking a search back up past
 *  this point is indistinguishable from starting a new one anyway. */
export const SESSION_TTL_MS = 15 * 60 * 1000;

/** Cache-shaped: bounded, not just time-limited. FIFO eviction (oldest first)
 *  since `getSession` already refreshes `touchedAt`. */
export const MAX_SESSIONS = 500;

const sessions = new Map<string, SearchSession>();

function isExpired(session: SearchSession, now: number): boolean {
  return now - session.touchedAt > SESSION_TTL_MS;
}

function sweepExpired(now: number): void {
  for (const [token, session] of sessions) {
    if (isExpired(session, now)) sessions.delete(token);
  }
}

function evictOldestIfFull(): void {
  if (sessions.size < MAX_SESSIONS) return;
  const oldest = sessions.keys().next().value;
  if (oldest !== undefined) sessions.delete(oldest);
}

/** 8 lower-case base36 characters (~41 bits) — short enough to leave room for
 *  the rest of `callback_data`, ample for a cache that outlives no restart. */
function randomToken(): string {
  return Array.from({ length: 8 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

export function createSession(query: string, mode: SearchMode): { token: string; session: SearchSession } {
  const now = Date.now();
  sweepExpired(now);
  evictOldestIfFull();
  let token = randomToken();
  while (sessions.has(token)) token = randomToken();
  const session: SearchSession = { query, mode, page: 1, createdAt: now, touchedAt: now };
  sessions.set(token, session);
  return { token, session };
}

/** Null for a token that's gone — expired, evicted, or pre-restart. A live
 *  lookup refreshes `touchedAt`, extending life past the idle TTL. */
export function getSession(token: string): SearchSession | null {
  const session = sessions.get(token);
  if (!session) return null;
  const now = Date.now();
  if (isExpired(session, now)) {
    sessions.delete(token);
    return null;
  }
  session.touchedAt = now;
  return session;
}

export function setPage(token: string, page: number): void {
  const session = sessions.get(token);
  if (session) session.page = page;
}

/** Test hook: a restart is not durable, so nothing here should outlive one. */
export function clearAllSessions(): void {
  sessions.clear();
}

export function sessionCount(): number {
  return sessions.size;
}
