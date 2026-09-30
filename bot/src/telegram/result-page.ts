import { InlineKeyboard } from 'grammy';
import type { BotBook, BotPage } from '../catalog/api-client.js';
import { moreData, pickData } from './callback.js';
import { bookLine, bookCaption, BUTTON_LABEL_LIMIT } from './book-text.js';

/** Result page (CONTEXT.md "Telegram bot"): one batch of five Books, the unit
 *  a user pages through — "more" means the next page, never a longer one. */
export const PAGE_SIZE = 5;

export interface ResultPage {
  /** One entry per book: the cover to fetch and its `book-text.ts` caption,
   *  each sent as its own message (not a `sendMediaGroup` album). */
  media: { bookId: number; caption: string }[];
  /** One row per book to pick it, plus a trailing "More" row when there's a
   *  next page. */
  keyboard: InlineKeyboard;
  summary: string;
}

export function hasButtons(page: ResultPage): boolean {
  return page.keyboard.inline_keyboard.length > 0;
}

/** Renders one Result page: the covers plus the message carrying selection
 *  buttons. `matchedAnywhere` labels an ADR-0001 fallback hit as such. */
export function buildResultPage(
  page: BotPage<BotBook>,
  token: string,
  matchedAnywhere: boolean,
): ResultPage {
  // Caption and pick button share the same 1-based position number, reset each page.
  const media = page.items.map((book, i) => ({
    bookId: book.id,
    caption: bookCaption(book, i + 1),
  }));

  // `row(button)` pushes one whole row per call; `.text().row()` would leave a
  // trailing empty row after the last button.
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
