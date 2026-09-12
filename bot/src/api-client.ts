// Thin HTTP client for the SOPDS catalog API. The bot is a catalog *client*,
// not a second catalog (see CONTEXT.md "Telegram bot"): every search and
// download below goes through the same endpoints an OPDS reader would use, and
// this module owns no schema of its own — just enough shape to render results.

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

export interface CatalogClientOpts {
  baseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

export class CatalogClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor({ baseUrl, fetchFn = fetch }: CatalogClientOpts) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchFn = fetchFn;
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /**
   * Title prefix search — the bot's only search: `GET /api/books?prefix=`,
   * i.e. `catalog.listBooks`'s prefix mode. See ADR 0001 for why this, and
   * not unified search, is what `/search` runs.
   */
  async titlePrefixSearch(prefix: string, page: number, limit: number): Promise<BotPage<BotBook>> {
    const res = await this.fetchFn(this.url('/api/books', { prefix, page, limit }));
    if (!res.ok) throw new Error(`GET /api/books ${res.status}`);
    return (await res.json()) as BotPage<BotBook>;
  }

  /**
   * The ADR 0001 fallback: when the prefix search finds nothing, retry with a
   * substring match still scoped to `type=books` (title/author/series union),
   * which the caller labels as "matched anywhere" rather than presenting
   * silently as a prefix hit.
   */
  async titleAnywhereSearch(query: string, page: number, limit: number): Promise<BotPage<BotBook>> {
    const res = await this.fetchFn(
      this.url('/api/search', { q: query, type: 'books', match: 'all', page, limit }),
    );
    if (!res.ok) throw new Error(`GET /api/search ${res.status}`);
    const body = (await res.json()) as { results: BotPage<BotBook> | null };
    return body.results ?? emptyPage(limit);
  }

  /** Null on a 404 (book gone since the search ran) rather than a thrown error,
   *  so callers can report it plainly instead of treating it as a fault. */
  async getBook(id: number): Promise<BotBook | null> {
    const res = await this.fetchFn(this.url(`/api/books/${id}`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET /api/books/${id} ${res.status}`);
    return (await res.json()) as BotBook;
  }

  /**
   * Fetches a Book's cover bytes so the bot can upload them to Telegram
   * directly, rather than handing Telegram a URL and expecting *its* servers
   * to fetch it: `SOPDS_API_URL` is typically only reachable from the bot
   * itself (e.g. the Docker-internal `http://api:8000`), never from
   * Telegram's, so a URL-based `sendMediaGroup` would 400 there regardless of
   * the book (see `bot.ts`'s `sendSearchOutcome`).
   *
   * Null only when the book itself is gone (404) — a book with no embedded
   * cover still comes back 200 with the server's own placeholder image.
   */
  async getCoverBytes(id: number): Promise<Buffer | null> {
    const res = await this.fetchFn(this.url(`/api/books/${id}/cover`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET /api/books/${id}/cover ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  downloadUrl(id: number, format: string): string {
    return this.url(`/api/books/${id}/download`, { format });
  }
}
