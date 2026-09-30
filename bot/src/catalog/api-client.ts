// Thin HTTP client for the SOPDS catalog API — the bot is a client, not a
// second catalog, and owns no schema of its own (see CONTEXT.md "Telegram bot").

export interface BotAuthor {
  id: number;
  full_name: string;
}

export interface BotSeries {
  id: number;
  ser: string;
  ser_no: number;
}

export interface BotGenre {
  id: number;
  genre: string;
  section: string;
  subsection: string;
}

export interface BotDownloadFormat {
  format: string;
  native: boolean;
  convertible: boolean;
  url: string;
}

export interface BotBook {
  id: number;
  title: string;
  format: string;
  filesize: number;
  lang: string;
  annotation: string;
  doc_date: string;
  authors: BotAuthor[];
  series: BotSeries[];
  genres: BotGenre[];
  /** present on GET /api/books/:id only */
  download_formats?: BotDownloadFormat[];
}

export interface BotPage<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  has_next: boolean;
  has_prev: boolean;
  partial?: boolean;
}

function emptyPage<T>(limit: number): BotPage<T> {
  return { items: [], total: 0, page: 1, limit, pages: 1, has_next: false, has_prev: false };
}

/** Per-call timeout: bounds how long a hung request can stall the bot, since
 *  grammY processes updates sequentially by default. See `bot.ts`'s `withCatalog`. */
export const CATALOG_TIMEOUT_MS = 10_000;

export interface CatalogClientOpts {
  baseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Per-call timeout; defaults to `CATALOG_TIMEOUT_MS`. Shortened in tests
   *  that exercise the timeout itself. */
  timeoutMs?: number;
}

export class CatalogClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor({ baseUrl, fetchFn = fetch, timeoutMs = CATALOG_TIMEOUT_MS }: CatalogClientOpts) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /** Every request goes through here, not `fetchFn` directly, so one shared
   *  timeout covers every catalog call. */
  private request(url: string): Promise<Response> {
    return this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
  }

  /** Title prefix search — the bot's only search (`GET /api/books?prefix=`).
   *  See ADR 0001 for why not Unified search. */
  async titlePrefixSearch(prefix: string, page: number, limit: number): Promise<BotPage<BotBook>> {
    const res = await this.request(this.url('/api/books', { prefix, page, limit }));
    if (!res.ok) throw new Error(`GET /api/books ${res.status}`);
    return (await res.json()) as BotPage<BotBook>;
  }

  /** The ADR 0001 fallback: retries as a substring match (`type=books`) when
   *  the prefix search finds nothing; the caller labels this "matched anywhere". */
  async titleAnywhereSearch(query: string, page: number, limit: number): Promise<BotPage<BotBook>> {
    const res = await this.request(
      this.url('/api/search', { q: query, type: 'books', match: 'all', page, limit }),
    );
    if (!res.ok) throw new Error(`GET /api/search ${res.status}`);
    const body = (await res.json()) as { results: BotPage<BotBook> | null };
    return body.results ?? emptyPage(limit);
  }

  /** Null on a 404 (book gone since the search ran) rather than a thrown error,
   *  so callers can report it plainly instead of treating it as a fault. */
  async getBook(id: number): Promise<BotBook | null> {
    const res = await this.request(this.url(`/api/books/${id}`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET /api/books/${id} ${res.status}`);
    return (await res.json()) as BotBook;
  }

  /** Cover bytes to upload directly — a URL-based `sendPhoto` would fail since
   *  Telegram can't reach `SOPDS_API_URL`. Null only when the book itself is gone (404). */
  async getCoverBytes(id: number): Promise<Buffer | null> {
    const res = await this.request(this.url(`/api/books/${id}/cover`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET /api/books/${id}/cover ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  downloadUrl(id: number, format: string): string {
    return this.url(`/api/books/${id}/download`, { format });
  }
}
