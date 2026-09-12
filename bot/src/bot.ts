import { Bot, InlineKeyboard, InputFile, type BotConfig as GrammyBotConfig, type Context } from 'grammy';
import type { BotConfig } from './config.js';
import { CatalogClient } from './api-client.js';
import { runSearch, moreResults, type SearchOutcome } from './search-flow.js';
import { parseCallback, downloadData } from './callback.js';
import { formatOffer } from './format-offer.js';
import { hasButtons } from './result-page.js';
import { formatBookDetails } from './book-text.js';

const START_MESSAGE =
  'Send /search <title> to look up a book by its title.\n' +
  'Pick a book from the results, then a format, to download it.';

const NOT_AUTHORIZED = 'You are not authorized to use this bot.';

/**
 * Allowed when either list matches: the sender is in `allowedUsers`, or the
 * chat itself is in `allowedChats` (a trusted group, regardless of which
 * member posted). Because it's an OR over the *sender's own id* rather than
 * "allowedUsers only applies in private chats", a listed user's identity
 * travels with them — they pass from any group too, allowlisted or not.
 * `allowedChats` is what lets an *un*listed member of a trusted group in;
 * it does not narrow what a listed user can already do.
 * Unrestricted — the default — only when *both* are `null`; setting either
 * one turns restriction on, so allowing a group without also opening every
 * private chat (or vice versa) is the common case, not a special one.
 */
function isAllowed(config: BotConfig, ctx: Context): boolean {
  if (config.allowedUsers === null && config.allowedChats === null) return true;
  const userId = ctx.from?.id;
  if (config.allowedUsers && userId !== undefined && config.allowedUsers.has(userId)) return true;
  const chatId = ctx.chat?.id;
  if (config.allowedChats && chatId !== undefined && config.allowedChats.has(chatId)) return true;
  return false;
}

/**
 * Sends a Search outcome: one photo+caption message per book (skipped when
 * there are no results), followed by the one message carrying the summary
 * and buttons.
 *
 * Deliberately *not* `sendMediaGroup`: Telegram only surfaces an album's
 * per-photo captions once a user taps into one, showing none of them in the
 * collapsed grid the chat feed renders by default — a caption meant to help
 * someone choose a book has to be visible without that extra tap, so each
 * book gets its own message instead.
 *
 * Covers are fetched through `api` and uploaded as bytes (`InputFile`), never
 * handed to Telegram as a URL for *its* servers to fetch: `SOPDS_API_URL` is
 * typically only reachable from the bot itself (e.g. the Docker-internal
 * `http://api:8000`), and a URL-based `sendPhoto` 400s there regardless of the
 * book — see `api-client.ts`'s `getCoverBytes`.
 */
async function sendSearchOutcome(
  ctx: Context,
  api: CatalogClient,
  outcome: SearchOutcome,
): Promise<void> {
  if (outcome.page.media.length) {
    const photos = await Promise.all(
      outcome.page.media.map(async (item) => {
        const cover = await api.getCoverBytes(item.bookId);
        // Null only means the book vanished between the search and this send
        // (see getCoverBytes) - drop it from the results rather than fail the
        // whole page over one book.
        if (!cover) return null;
        return { bookId: item.bookId, cover, caption: item.caption };
      }),
    );
    // Sent one at a time, in order, rather than in parallel: nothing here
    // requires the speed, and a Telegram chat has no ordering guarantee
    // beyond the order the sends themselves arrive in.
    for (const photo of photos) {
      if (!photo) continue;
      await ctx.replyWithPhoto(new InputFile(photo.cover, `cover-${photo.bookId}.jpg`), {
        caption: photo.caption,
      });
    }
  }
  await ctx.reply(
    outcome.page.summary,
    hasButtons(outcome.page) ? { reply_markup: outcome.page.keyboard } : undefined,
  );
}

/** Assembles the bot's handlers around a `CatalogClient`. Takes the client as
 *  a parameter (rather than building one from `config` internally) so tests
 *  can supply a fake one without a real Telegram Bot API token.
 *  `grammyOptions` passes through to the `Bot` constructor — unused in
 *  production, where the default (a real `getMe` + the real Bot API) is what
 *  we want, but how tests supply a canned `botInfo` and a fake `client.fetch`
 *  instead of reaching Telegram at all. */
export function createBot(
  config: BotConfig,
  api: CatalogClient,
  grammyOptions?: GrammyBotConfig<Context>,
): Bot {
  const bot = new Bot(config.token, grammyOptions);

  // Access control first, ahead of every command/callback handler below:
  // an unlisted user gets a plain refusal (or a callback alert) and nothing
  // else runs for them.
  bot.use(async (ctx, next) => {
    if (isAllowed(config, ctx)) return next();
    if (ctx.callbackQuery) {
      return ctx.answerCallbackQuery({ text: NOT_AUTHORIZED, show_alert: true });
    }
    // Anything with a chat (i.e. every message) gets a plain refusal; other
    // update types the bot never handles anyway (reactions, chat-member
    // updates, ...) are just dropped rather than risking a reply with no
    // chat to send it to.
    if (ctx.chat) return ctx.reply(NOT_AUTHORIZED);
  });

  bot.command('start', (ctx) => ctx.reply(START_MESSAGE));

  bot.command('search', async (ctx) => {
    const query = String(ctx.match ?? '').trim();
    if (!query) return ctx.reply('Usage: /search <title>');
    await sendSearchOutcome(ctx, api, await runSearch(api, query));
  });

  bot.on('callback_query:data', async (ctx) => {
    const action = parseCallback(ctx.callbackQuery.data);
    if (!action) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();

    if (action.kind === 'more') {
      const outcome = await moreResults(api, action.token);
      if (!outcome) return ctx.reply('This search has expired — send /search again.');
      return sendSearchOutcome(ctx, api, outcome);
    }

    if (action.kind === 'pick') {
      const book = await api.getBook(action.bookId);
      if (!book) return ctx.reply('That book is no longer available.');
      // See result-page.ts for why this is `row(text(...))`, not `.text().row()`.
      const keyboard = new InlineKeyboard([]);
      for (const format of formatOffer(book)) {
        keyboard.row(InlineKeyboard.text(format.toUpperCase(), downloadData(book.id, format)));
      }
      return ctx.reply(formatBookDetails(book), { reply_markup: keyboard });
    }

    // action.kind === 'download'
    const book = await api.getBook(action.bookId);
    if (!book) return ctx.reply('That book is no longer available.');
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(api.downloadUrl(book.id, action.format));
      if (!res.ok) throw new Error(String(res.status));
      bytes = await res.arrayBuffer();
    } catch {
      return ctx.reply('Download failed — try again later.');
    }
    return ctx.replyWithDocument(
      new InputFile(Buffer.from(bytes), `${book.title}.${action.format}`),
    );
  });

  return bot;
}
