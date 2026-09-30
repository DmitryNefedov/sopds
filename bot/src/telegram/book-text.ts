// Renders a `BotBook` as text: a pick button's bare label, a Result page's
// caption, and the full Book detail message.

import type { BotBook } from '../catalog/api-client.js';

/** Telegram caption limit for a photo. */
export const CAPTION_LIMIT = 1024;
/** Telegram's plain-message text limit. */
export const MESSAGE_LIMIT = 4096;
/** Comfortably under Telegram's inline button text limit. */
export const BUTTON_LABEL_LIMIT = 60;

/** "Title — Author, Author"; title alone with no authors. `number` prefixes
 *  "N. " to match a Result page's caption to its pick button. */
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

/** Result-page caption: numbered `bookLine` plus series, language, and an
 *  annotation snippet, truncated to Telegram's caption limit. */
export function bookCaption(book: BotBook, number: number): string {
  const lines = [bookLine(book, number)];
  const series = seriesText(book);
  if (series) lines.push(`Series: ${series}`);
  if (book.lang) lines.push(`Language: ${book.lang}`);
  if (book.annotation) lines.push('', book.annotation);
  return lines.join('\n').slice(0, CAPTION_LIMIT);
}

/** Full Book detail text sent after a pick: everything the web UI's Book
 *  detail page shows, including the whole annotation. */
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
