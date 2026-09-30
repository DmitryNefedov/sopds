import { Bot, InlineKeyboard, InputFile, type BotConfig as GrammyBotConfig, type Context } from 'grammy';
import type { BotConfig } from '../config.js';
import { CatalogClient, CATALOG_TIMEOUT_MS, type BotBook } from '../catalog/api-client.js';
import { runSearch, moreResults, type SearchOutcome } from '../search/search-flow.js';
import { parseCallback, downloadData } from './callback.js';
import { formatOffer } from './format-offer.js';
import { hasButtons } from './result-page.js';
import { formatBookDetails } from './book-text.js';

const START_MESSAGE =
  'Send /search <title> to look up a book by its title.\n' +
  'Pick a book from the results, then a format, to download it.';

const NOT_AUTHORIZED = 'You are not authorized to use this bot.';

const CATALOG_ERROR_MESSAGE = 'The catalog is not responding — try again in a moment.';

/** Allowed when either allowedUsers or allowedChats matches (OR, not AND) —
 *  both `null` (the default) means unrestricted. */
function isAllowed(config: BotConfig, ctx: Context): boolean {
  if (config.allowedUsers === null && config.allowedChats === null) return true;
  const userId = ctx.from?.id;
  if (config.allowedUsers && userId !== undefined && config.allowedUsers.has(userId)) return true;
  const chatId = ctx.chat?.id;
  if (config.allowedChats && chatId !== undefined && config.allowedChats.has(chatId)) return true;
  return false;
}

/** Runs a catalog call and replies with one message on failure instead of
 *  vanishing into `bot.catch`. `undefined` means the reply was already sent. */
async function withCatalog<T>(ctx: Context, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    await ctx.reply(CATALOG_ERROR_MESSAGE);
    return undefined;
  }
}

/** Sends one photo+caption message per book, then the summary+buttons message.
 *  Not `sendMediaGroup`: Telegram hides an album's per-photo captions until tapped. */
async function sendSearchOutcome(
  ctx: Context,
  api: CatalogClient,
  outcome: SearchOutcome,
): Promise<void> {
  if (outcome.page.media.length) {
    const photos = await Promise.all(
      outcome.page.media.map(async (item) => {
        const cover = await api.getCoverBytes(item.bookId);
        // Book vanished since the search ran — drop it rather than fail the page.
        if (!cover) return null;
        return { bookId: item.bookId, cover, caption: item.caption };
      }),
    );
    // Sent one at a time, in order: nothing here needs the speed, and Telegram
    // gives no ordering guarantee beyond send order.
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

/** Assembles the bot's handlers around a `CatalogClient`, injected so tests
 *  can supply a fake one without a real Bot API token. */
export function createBot(
  config: BotConfig,
  api: CatalogClient,
  grammyOptions?: GrammyBotConfig<Context>,
): Bot {
  const bot = new Bot(config.token, grammyOptions);

  // Access control first: an unlisted user gets a refusal and nothing else runs.
  bot.use(async (ctx, next) => {
    if (isAllowed(config, ctx)) return next();
    console.warn('sopds-bot: rejected unauthorized access', {
      userId: ctx.from?.id,
      username: ctx.from?.username,
      chatId: ctx.chat?.id,
      chatType: ctx.chat?.type,
      text: ctx.message?.text,
      callbackData: ctx.callbackQuery?.data,
    });
    if (ctx.callbackQuery) {
      return ctx.answerCallbackQuery({ text: NOT_AUTHORIZED, show_alert: true });
    }
    // Every message gets a refusal; other update types are just dropped since
    // there's no chat to reply to.
    if (ctx.chat) return ctx.reply(NOT_AUTHORIZED);
  });

  bot.command('start', (ctx) => ctx.reply(START_MESSAGE));

  bot.command('search', async (ctx) => {
    const query = String(ctx.match ?? '').trim();
    if (!query) return ctx.reply('Usage: /search <title>');
    await withCatalog(ctx, async () => {
      await sendSearchOutcome(ctx, api, await runSearch(api, query));
    });
  });

  bot.on('callback_query:data', async (ctx) => {
    const action = parseCallback(ctx.callbackQuery.data);
    if (!action) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();

    if (action.kind === 'more') {
      return withCatalog(ctx, async () => {
        const outcome = await moreResults(api, action.token);
        if (!outcome) return ctx.reply('This search has expired — send /search again.');
        return sendSearchOutcome(ctx, api, outcome);
      });
    }

    if (action.kind === 'pick') {
      const book = await withCatalog(ctx, () => api.getBook(action.bookId));
      if (book === undefined) return; // withCatalog already replied
      if (!book) return ctx.reply('That book is no longer available.');
      // See result-page.ts for why this is `row(text(...))`, not `.text().row()`.
      const keyboard = new InlineKeyboard([]);
      for (const format of formatOffer(book)) {
        keyboard.row(InlineKeyboard.text(format.toUpperCase(), downloadData(book.id, format)));
      }
      return ctx.reply(formatBookDetails(book), { reply_markup: keyboard });
    }

    // action.kind === 'download'
    const book: BotBook | null | undefined = await withCatalog(ctx, () => api.getBook(action.bookId));
    if (book === undefined) return; // withCatalog already replied
    if (!book) return ctx.reply('That book is no longer available.');
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(api.downloadUrl(book.id, action.format), {
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      });
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
