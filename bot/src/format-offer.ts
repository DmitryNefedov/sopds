import type { BotBook } from './api-client.js';

/**
 * Format offer (CONTEXT.md "Telegram bot"): the formats a Book can actually
 * be delivered in — every convertible format when its own format is one of
 * them, otherwise its native format alone.
 *
 * Distinct from `GET /api/books/:id`'s `download_formats`, which flags a
 * format `convertible` only in terms of the *target* list the server always
 * offers (fb2/epub/mobi) and so omits a non-convertible native format (pdf,
 * djvu, …) entirely. Every entry in `download_formats` shares the same
 * `convertible` value (it depends only on the book's own format, not the
 * target), so "any convertible entry" and "the source format is convertible"
 * are the same test; this just also restores the native format when neither
 * holds, which `download_formats` cannot express on its own.
 */
export function formatOffer(book: BotBook): string[] {
  const convertible = (book.download_formats ?? [])
    .filter((f) => f.convertible)
    .map((f) => f.format);
  return convertible.length ? convertible : [book.format];
}
