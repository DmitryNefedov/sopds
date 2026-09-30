import type { BotBook } from '../catalog/api-client.js';

/** Formats a Book can actually be delivered in: every convertible format
 *  when its own is one, otherwise just its native format. */
export function formatOffer(book: BotBook): string[] {
  const convertible = (book.download_formats ?? [])
    .filter((f) => f.convertible)
    .map((f) => f.format);
  return convertible.length ? convertible : [book.format];
}
