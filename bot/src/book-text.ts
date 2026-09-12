// Renders a `BotBook` as text, for the three places the bot shows one:
// a Result page's pick button (bare title/author, short), its photo caption
// (title/author plus enough to tell books apart), and the full detail message
// sent after a pick (everything the web UI's Book detail page shows). See
// CONTEXT.md "Telegram bot".

import type { BotBook } from './api-client.js';

/** Telegram caption limit for a photo. */
export const CAPTION_LIMIT = 1024;
/** Telegram's plain-message text limit. */
export const MESSAGE_LIMIT = 4096;
/** Comfortably under Telegram's inline button text limit. */
export const BUTTON_LABEL_LIMIT = 60;

/** "Title — Author, Author"; title alone when there are no authors. Used for
 *  both a pick button's label and the first line of every longer rendering
 *  below.
 *
 * @param number This book's 1-based position in its Result page, when
 *   rendering one — prefixed as `"N. "` so the same number a user sees on a
 *   cover's caption also labels its pick button, letting them match one to
 *   the other without recounting the album. Omitted outside a Result page
 *   (the Book detail message), where there is only one book to number. */
export function bookLine(book: BotBook, number?: number): string {
  const authors = book.authors.map((a) => a.full_name).join(', ');
  const line = authors ? `${book.title} — ${authors}` : book.title;
  return number !== undefined ? `${number}. ${line}` : line;
}

function seriesText(book: BotBook): string {
  return book.series.map((s) => (s.ser_no ? `${s.ser} #${s.ser_no}` : s.ser)).join(', ');
}

function genresText(book: BotBook): string {
  return book.genres.map((g) => g.subsection).join(', ');
}

function metaLine(book: BotBook): string {
  const parts: string[] = [];
  if (book.format) parts.push(book.format.toUpperCase());
  if (book.filesize) parts.push(`${Math.round(book.filesize / 1024)} KB`);
  if (book.doc_date) parts.push(book.doc_date);
  if (book.lang) parts.push(book.lang);
  return parts.join(' · ');
}

/**
 * Result-page caption: `bookLine` (with its position number, so it lines up
 * with the same number on the pick button underneath) plus series and
 * language, so a user can tell same-titled or same-cover editions apart, and
 * a short annotation snippet to judge the book itself — without opening it
 * first. Truncated to the photo caption limit; a long annotation loses its
 * tail here, never the fields before it, since those are built first and the
 * slice is last.
 */
export function bookCaption(book: BotBook, number: number): string {
  const lines = [bookLine(book, number)];
  const series = seriesText(book);
  if (series) lines.push(`Series: ${series}`);
  if (book.lang) lines.push(`Language: ${book.lang}`);
  if (book.annotation) lines.push('', book.annotation);
  return lines.join('\n').slice(0, CAPTION_LIMIT);
}

/**
 * Full Book detail text sent after a pick, alongside its format buttons:
 * everything the web UI's Book detail page shows for it — title, authors,
 * series, genres, format/size/date/language, and the full annotation — so
 * the format choice isn't made blind on a bare title.
 */
export function formatBookDetails(book: BotBook): string {
  const lines = [bookLine(book)];
  const series = seriesText(book);
  if (series) lines.push(`Series: ${series}`);
  const genres = genresText(book);
  if (genres) lines.push(`Genres: ${genres}`);
  const meta = metaLine(book);
  if (meta) lines.push(meta);
  if (book.annotation) lines.push('', book.annotation);
  return lines.join('\n').slice(0, MESSAGE_LIMIT);
}
