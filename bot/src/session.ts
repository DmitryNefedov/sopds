// Search session: a Title prefix search (or its ADR-0001 title-anywhere
// fallback) plus its page cursor, addressed by an opaque short token so a
// paging button can name it within the 64 bytes Telegram allows for
// `callback_data`. Cache-shaped and deliberately not durable, per CONTEXT.md:
// a session outlives neither a restart nor eviction, and `getSession` reports
// a gone one as expired rather than guessing.

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

/** Cache-shaped means bounded, not just time-limited: a burst of searches
 *  cannot grow this without end. Insertion order (oldest first) is what a
 *  `Map` iterates in, so the eviction below is a plain FIFO, not a true LRU —
 *  fine here since `getSession` already refreshes `touchedAt` and the TTL
 *  sweep is what clears out genuinely idle entries. */
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

/** Null for a token that is gone — expired, evicted, or from before a restart
 *  — never guessed at. A live lookup refreshes `touchedAt`, so an
 *  actively-paged search stays alive past the idle TTL. */
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

/** Test hook: a restart is not durable, so nothing here should outlive one —
 *  this simulates that in-process. */
export function clearAllSessions(): void {
  sessions.clear();
}

export function sessionCount(): number {
  return sessions.size;
}
