import type { CatalogClient, BotPage, BotBook } from './api-client.js';
import { createSession, getSession, setPage, type SearchMode } from './session.js';
import { PAGE_SIZE, buildResultPage, type ResultPage } from './result-page.js';

export interface SearchOutcome {
  /** Null when the search (including the fallback) found nothing — there is
   *  no session to page, so no token is minted. */
  token: string | null;
  page: ResultPage;
}

function fetchPage(
  api: CatalogClient,
  query: string,
  mode: SearchMode,
  page: number,
): Promise<BotPage<BotBook>> {
  return mode === 'prefix'
    ? api.titlePrefixSearch(query, page, PAGE_SIZE)
    : api.titleAnywhereSearch(query, page, PAGE_SIZE);
}

/**
 * Runs a Title prefix search for `/search <query>`. Per ADR 0001, when that
 * comes back empty it retries as the title-anywhere fallback and labels the
 * result as having matched anywhere rather than presenting a silent prefix
 * hit. Either way that starts a fresh Search session, unless both passes
 * found nothing, in which case there is nothing to page.
 */
export async function runSearch(api: CatalogClient, query: string): Promise<SearchOutcome> {
  let mode: SearchMode = 'prefix';
  let result = await fetchPage(api, query, mode, 1);
  if (result.items.length === 0) {
    mode = 'anywhere';
    result = await fetchPage(api, query, mode, 1);
  }
  if (result.items.length === 0) {
    return { token: null, page: buildResultPage(result, '', mode === 'anywhere') };
  }
  const { token } = createSession(query, mode);
  return { token, page: buildResultPage(result, token, mode === 'anywhere') };
}

/**
 * Advances a Search session to its next Result page ("more" never means a
 * longer page, only the next one). Null when the session is gone — expired,
 * evicted, or from before a restart — for the caller to report as expired
 * rather than guess at.
 */
export async function moreResults(api: CatalogClient, token: string): Promise<SearchOutcome | null> {
  const session = getSession(token);
  if (!session) return null;
  const nextPage = session.page + 1;
  const result = await fetchPage(api, session.query, session.mode, nextPage);
  setPage(token, nextPage);
  return { token, page: buildResultPage(result, token, session.mode === 'anywhere') };
}
