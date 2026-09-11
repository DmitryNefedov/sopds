import { Bot, InlineKeyboard, InputFile, type BotConfig as GrammyBotConfig, type Context } from 'grammy';
import type { BotConfig } from './config.js';
import { CatalogClient } from './api-client.js';
import { runSearch, moreResults, type SearchOutcome } from './search-flow.js';
import { parseCallback, downloadData } from './callback.js';
import { formatOffer } from './format-offer.js';
import { hasButtons } from './result-page.js';

const START_MESSAGE =
  'Send /search <title> to look up a book by its title.\n' +
  'Pick a book from the results, then a format, to download it.';

/** Sends a Search outcome: the album of covers (skipped when there are no
 *  results) followed by the one message carrying the summary and buttons. */
async function sendSearchOutcome(ctx: Context, outcome: SearchOutcome): Promise<void> {
  if (outcome.page.media.length) await ctx.replyWithMediaGroup(outcome.page.media);
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

  bot.command('start', (ctx) => ctx.reply(START_MESSAGE));

  bot.command('search', async (ctx) => {
    const query = String(ctx.match ?? '').trim();
    if (!query) return ctx.reply('Usage: /search <title>');
    await sendSearchOutcome(ctx, await runSearch(api, query));
  });

  bot.on('callback_query:data', async (ctx) => {
    const action = parseCallback(ctx.callbackQuery.data);
    if (!action) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();

    if (action.kind === 'more') {
      const outcome = await moreResults(api, action.token);
      if (!outcome) return ctx.reply('This search has expired — send /search again.');
      return sendSearchOutcome(ctx, outcome);
    }

    if (action.kind === 'pick') {
      const book = await api.getBook(action.bookId);
      if (!book) return ctx.reply('That book is no longer available.');
      // See result-page.ts for why this is `row(text(...))`, not `.text().row()`.
      const keyboard = new InlineKeyboard([]);
      for (const format of formatOffer(book)) {
        keyboard.row(InlineKeyboard.text(format.toUpperCase(), downloadData(book.id, format)));
      }
      const authors = book.authors.map((a) => a.full_name).join(', ');
      return ctx.reply(authors ? `${book.title}\n${authors}` : book.title, {
        reply_markup: keyboard,
      });
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
