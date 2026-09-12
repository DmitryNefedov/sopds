import { InlineKeyboard } from 'grammy';
import type { BotBook, BotPage } from './api-client.js';
import { moreData, pickData } from './callback.js';
import { bookLine, bookCaption, BUTTON_LABEL_LIMIT } from './book-text.js';

/** Result page (CONTEXT.md "Telegram bot"): one batch of five Books, the unit
 *  a user pages through — "more" means the next page, never a longer one. */
export const PAGE_SIZE = 5;

export interface ResultPage {
  /** One entry per book, same order as the page's items: the id to fetch a
   *  cover for and the `book-text.ts` caption to send it with (title, author,
   *  series, language, and an annotation snippet — enough to choose without
   *  opening the book). Deliberately not a ready `InputMediaPhoto[]` —
   *  fetching cover bytes is async (a network call), rendering a Result page
   *  isn't; `bot.ts`'s `sendSearchOutcome` does the fetching. Empty when the
   *  page has none, in which case no album is sent at all. */
  media: { bookId: number; caption: string }[];
  /** The single message's inline keyboard: one row per book to pick it, plus
   *  a trailing "More" row when the page has a next one. Empty (no rows) when
   *  there is nothing to page or select. */
  keyboard: InlineKeyboard;
  /** Plain-text summary sent alongside the keyboard. */
  summary: string;
}

export function hasButtons(page: ResultPage): boolean {
  return page.keyboard.inline_keyboard.length > 0;
}

/**
 * Renders one Result page: the album of covers plus the message carrying the
 * selection buttons, built from a `BotPage<BotBook>` and the Search session
 * token that pages it further.
 *
 * @param matchedAnywhere Whether this page came from the ADR-0001 fallback
 *   (a title-anywhere match) rather than the prefix search, so the summary
 *   can say so instead of presenting it as a plain prefix hit.
 */
export function buildResultPage(
  page: BotPage<BotBook>,
  token: string,
  matchedAnywhere: boolean,
): ResultPage {
  // Both the caption and the pick button below it are numbered by the book's
  // 1-based position in this page (never a global rank across pages), so the
  // two always agree on what "1", "2", ... refers to.
  const media = page.items.map((book, i) => ({
    bookId: book.id,
    caption: bookCaption(book, i + 1),
  }));

  // `new InlineKeyboard()` (no args) starts pre-seeded with one empty row, and
  // `.text().row()` fills-then-appends, leaving a trailing empty row after the
  // last button — `row(button)` instead always pushes a whole new row, so an
  // explicit `[]` start plus one `row()` call per button is exactly one row
  // per button, no more.
  const keyboard = new InlineKeyboard([]);
  page.items.forEach((book, i) => {
    keyboard.row(
      InlineKeyboard.text(bookLine(book, i + 1).slice(0, BUTTON_LABEL_LIMIT), pickData(book.id)),
    );
  });
  if (page.has_next) keyboard.row(InlineKeyboard.text('More ▸', moreData(token)));

  const summary = summaryFor(page, matchedAnywhere);
  return { media, keyboard, summary };
}

function summaryFor(page: BotPage<BotBook>, matchedAnywhere: boolean): string {
  if (!page.items.length) return 'No books found.';
  const scope = matchedAnywhere ? 'title contains your search' : 'title starts with your search';
  const known = page.partial ? '' : ` of ${page.total}`;
  return `${page.items.length} book(s) whose ${scope}${known}:`;
}
